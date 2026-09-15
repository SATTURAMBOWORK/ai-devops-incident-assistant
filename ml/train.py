"""
Train the log -> runbook category classifier.

Run it with:    .venv/Scripts/python.exe train.py
(prepare_loghub.py must have been run once first - see that file.)

This script is the whole "learning" half of the ML service. It reads the
labelled dataset, trains a model, prints how well that model does on data it has
never seen, and writes the trained model to disk. The FastAPI service (main.py)
only ever loads that file - it never trains.

Keeping training and serving in separate files matters: training is slow,
occasional and done by a human who looks at the numbers; serving is fast,
constant and automatic. Mixing them would mean retraining on every deploy and
never noticing if the model quietly got worse.
"""

import json
from pathlib import Path

import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.pipeline import Pipeline

from augment import augment, load_noise_lines
from predict import UNKNOWN_LABEL, normalize, predict_label

# Paths are relative to this file, not to the shell's working directory, so the
# script works no matter where you run it from.
HERE = Path(__file__).parent
DATA_PATHS = [
    HERE / "data" / "incidents.jsonl",         # hand-written examples
    HERE / "data" / "loghub_incidents.jsonl",  # real incidents, from prepare_loghub.py
]
MODEL_PATH = HERE / "model.joblib"

# Fixing the random seed makes the train/test split identical on every run.
# Without it, your accuracy would jump around between runs and you could never
# tell whether a change to the model helped or you just got a luckier split.
RANDOM_SEED = 42

# Fraction of the data held back for testing. 0.2 of ~570 rows is ~115
# incidents - still small, which is why we also cross-validate further down.
TEST_SIZE = 0.2


def load_dataset(paths):
    """Read the JSONL datasets into two parallel lists: texts and labels."""
    texts, labels = [], []
    for path in paths:
        if not path.exists():
            raise SystemExit(f"{path} not found. Run prepare_loghub.py first.")
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                texts.append(row["text"])
                labels.append(row["label"])
    return texts, labels


def build_model():
    """
    Assemble the model as a Pipeline: vectorizer + classifier as one object.

    A Pipeline matters more than it looks. The vectorizer learns a vocabulary
    and word weights from the TRAINING data only. If we fitted it separately we
    could easily let it peek at the test set - "data leakage" - and get a great
    score that collapses in production. A Pipeline makes the correct thing the
    easy thing, and it means model.joblib contains the vectorizer too, so the
    API cannot accidentally use different preprocessing than training did.
    """
    vectorizer = TfidfVectorizer(
        # Lower-cases (OOMKilled, oomkilled -> one feature, not two rare ones)
        # and masks numbers, so timestamps and PIDs are not features. It lives
        # in predict.py because the saved model needs to import it again.
        preprocessor=normalize,
        # Unigrams alone lose word order: "no space left" and "space" mean
        # different things. Adding bigrams keeps pairs like "address already",
        # "connection refused", "heap limit" as single features - and those
        # pairs are exactly what distinguishes our categories.
        ngram_range=(1, 2),
        # Each hand-written incident appears once, so a term seen in a single
        # example is still a signal. Raising this would throw away the rare
        # error codes (ENOSPC, EADDRINUSE, EMFILE) that are the most
        # discriminative features we have.
        min_df=1,
        # Dampens raw counts with 1 + log(tf). A stack trace repeating the same
        # word 40 times should not count 40x more than a log that says it once.
        sublinear_tf=True,
        # No stop-word removal on purpose: in logs, words like "no", "not" and
        # "on" carry meaning ("no space left on device").
    )

    classifier = LogisticRegression(
        # The default 100 iterations is not always enough to converge on
        # high-dimensional TF-IDF features; 1000 avoids a convergence warning.
        max_iter=1000,
        # Inverse regularisation strength. Higher = the model is allowed to fit
        # the training data harder. The default 1.0 kept the weights on rare
        # error codes (EMFILE, ENOTFOUND) too small to stand out in a noisy log;
        # 10 scored better on held-out noisy logs, and 30 no better again - so
        # we stop at the smallest value that helps, to limit memorisation.
        C=10.0,
        random_state=RANDOM_SEED,
    )

    return Pipeline([("tfidf", vectorizer), ("clf", classifier)])


def show_top_features(model, n=4):
    """
    Print the words that push hardest toward each category.

    This is the payoff of choosing Logistic Regression over something opaque:
    the model is just a weight per word per class, so you can read what it
    learned. If a class's top features look like nonsense, the problem is the
    dataset, not the algorithm - and you will see that here before you ever
    deploy it.
    """
    vectorizer = model.named_steps["tfidf"]
    clf = model.named_steps["clf"]
    feature_names = vectorizer.get_feature_names_out()

    print("\nTop features per class (what the model keyed on)")
    print("-" * 64)
    for i, label in enumerate(clf.classes_):
        weights = clf.coef_[i]
        # argsort ascending, so the last n indices are the largest weights.
        top_idx = weights.argsort()[-n:][::-1]
        top = ", ".join(feature_names[j] for j in top_idx)
        print(f"  {label:24} {top}")


def print_confusion_matrix(y_true, y_pred, labels):
    """
    Print the confusion matrix as text.

    Accuracy is one number and hides everything interesting. The matrix shows
    WHICH classes get mixed up: row = the true label, column = what the model
    guessed. Everything off the diagonal is a mistake, and the pattern of those
    mistakes tells you what to fix in the dataset.
    """
    matrix = confusion_matrix(y_true, y_pred, labels=labels)

    print("\nConfusion matrix (row = actual, column = predicted)")
    print("-" * 64)
    # Short header codes, because the full label names are far too wide.
    codes = [label[:6] for label in labels]
    print(f"{'':26}" + "".join(f"{c:>7}" for c in codes))
    for label, row in zip(labels, matrix):
        print(f"  {label:24}" + "".join(f"{v:>7}" for v in row))


def cross_validate(texts, labels, noise_pool, folds=5):
    """
    Accuracy over `folds` different train/test splits.

    sklearn's cross_val_score cannot be used here: it would split data that is
    already augmented, putting noisy copies of the same incident on both sides.
    So each fold splits the ORIGINAL incidents first and augments each half on
    its own - exactly what main() does for the single split.
    """
    splitter = StratifiedKFold(n_splits=folds, shuffle=True, random_state=RANDOM_SEED)
    scores = []
    for fold, (train_idx, test_idx) in enumerate(splitter.split(texts, labels)):
        X_tr, y_tr = augment([texts[i] for i in train_idx], [labels[i] for i in train_idx],
                             noise_pool, seed=RANDOM_SEED + fold)
        X_te, y_te = augment([texts[i] for i in test_idx], [labels[i] for i in test_idx],
                             noise_pool, seed=RANDOM_SEED + 100 + fold)
        model = build_model().fit(X_tr, y_tr)
        scores.append(accuracy_score(y_te, predict_all(model, X_te)))
    return scores


def predict_all(model, texts):
    """
    Predict the way main.py does - windowed, with the confidence floor.

    NOT model.predict(): that classifies each log as one bag of words, which is
    not what the API serves, so its score would describe the wrong model.
    """
    return [predict_label(model, text) for text in texts]


def main():
    texts, labels = load_dataset(DATA_PATHS)
    noise_pool = load_noise_lines()
    print(f"Loaded {len(texts)} incidents across {len(set(labels))} categories, "
          f"{len(noise_pool)} noise lines")

    # Split the ORIGINAL incidents, before any augmentation. stratify=labels
    # keeps the class proportions identical in both halves, so no category ends
    # up with zero test samples.
    X_train, X_test, y_train, y_test = train_test_split(
        texts,
        labels,
        test_size=TEST_SIZE,
        random_state=RANDOM_SEED,
        stratify=labels,
    )

    # Augment each side on its own, with different seeds, so the test set's
    # noise and "unknown" samples are ones the model has never seen either.
    X_train_aug, y_train_aug = augment(X_train, y_train, noise_pool, seed=RANDOM_SEED)
    X_test_aug, y_test_aug = augment(X_test, y_test, noise_pool, seed=RANDOM_SEED + 1)
    print(f"Split: {len(X_train)} training incidents -> {len(X_train_aug)} samples after augmentation, "
          f"{len(X_test)} test incidents -> {len(X_test_aug)} samples")

    model = build_model()
    model.fit(X_train_aug, y_train_aug)

    vocab_size = len(model.named_steps["tfidf"].get_feature_names_out())
    print(f"Vocabulary learned: {vocab_size} features (words and word pairs)")

    # The real score: predictions on samples the model has never seen.
    y_pred = predict_all(model, X_test_aug)

    print("\nHeld-out test set results (clean + noisy + unknown)")
    print("-" * 64)
    # zero_division=0 keeps the report readable when a tiny test set happens to
    # give some class no predictions at all.
    print(classification_report(y_test_aug, y_pred, zero_division=0))

    # The same test incidents, split by kind. A model can look fine overall
    # while failing badly on exactly the noisy logs real users paste.
    clean_acc = accuracy_score(y_test, predict_all(model, X_test))
    clean_set = set(X_test)
    noisy = [(x, y) for x, y in zip(X_test_aug, y_test_aug) if y != UNKNOWN_LABEL and x not in clean_set]
    noisy_acc = accuracy_score([y for _, y in noisy], predict_all(model, [x for x, _ in noisy]))
    unknown = [x for x, y in zip(X_test_aug, y_test_aug) if y == UNKNOWN_LABEL]
    unknown_acc = accuracy_score([UNKNOWN_LABEL] * len(unknown), predict_all(model, unknown))
    print("Accuracy by kind of log")
    print(f"  clean snippets        {clean_acc:.3f}  ({len(X_test)})")
    print(f"  buried in noise       {noisy_acc:.3f}  ({len(noisy)})")
    print(f"  healthy (unknown)     {unknown_acc:.3f}  ({len(unknown)})")

    print_confusion_matrix(y_test_aug, y_pred, sorted(set(y_test_aug)))

    # A ~115-incident test set is small enough that one lucky or unlucky split
    # can move accuracy by several points. 5-fold cross-validation retrains the
    # model five times, each time holding out a different fifth, so every
    # incident gets tested exactly once. The spread across folds tells you how
    # much to trust the single number above.
    scores = cross_validate(texts, labels, noise_pool)
    mean = sum(scores) / len(scores)
    spread = max(scores) - min(scores)
    print("\n5-fold cross-validation")
    print("-" * 64)
    print("  per-fold accuracy: " + ", ".join(f"{s:.3f}" for s in scores))
    print(f"  mean {mean:.3f}  (range {spread:.3f})")

    show_top_features(model)

    # Retrain on ALL the data before saving. The split existed to measure the
    # model honestly; now that we have our number, throwing away 20% of a small
    # dataset would only make the shipped model worse. This is standard practice
    # - evaluate on a split, ship a model trained on everything.
    all_texts, all_labels = augment(texts, labels, noise_pool, seed=RANDOM_SEED)
    final_model = build_model()
    final_model.fit(all_texts, all_labels)
    joblib.dump(final_model, MODEL_PATH)
    print(f"\nSaved model -> {MODEL_PATH.name} (trained on {len(all_texts)} samples, "
          f"{len(final_model.named_steps['clf'].classes_)} categories)")


if __name__ == "__main__":
    main()
