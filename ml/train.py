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
from sklearn.model_selection import StratifiedKFold
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
# Real logs for evaluation only - deliberately not in DATA_PATHS.
REAL_EVAL_PATH = HERE / "data" / "real_eval.jsonl"

# Fixing the random seed makes the cross-validation folds identical on every
# run. Without it, your accuracy would jump around between runs and you could
# never tell whether a change to the model helped or you just got luckier folds.
RANDOM_SEED = 42

# 5 folds: each model trains on 80% and is tested on the other 20%, and every
# incident is tested exactly once across the five.
FOLDS = 5


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
        # Lower-cases (OOMKilled, oomkilled -> one feature, not two rare ones),
        # drops timestamp/hostname prefixes and masks numbers except meaningful
        # codes like 137 and 503 - see normalize(). It lives in predict.py
        # because the saved model needs to import it again.
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


def cross_validate(texts, labels, noise_pool, folds=FOLDS):
    """
    Train and test `folds` models, each holding out a different fifth of the data.

    Every report in main() comes from here. There used to be a separate single
    80/20 split as well, but its ~130 test incidents were too few: adding 60
    rows of data once changed which incidents landed in it and made oom-killed
    recall appear to fall from 0.97 to 0.67, when cross-validation showed it
    unchanged. Pooling all folds tests every incident exactly once.

    sklearn's cross_val_score cannot be used here: it would split data that is
    already augmented, putting noisy copies of the same incident on both sides.
    So each fold splits the ORIGINAL incidents first (stratified, so every
    category is in every fold) and augments each side on its own, with its own
    seed, so the test side's noise and "unknown" logs are unseen too.

    Returns per-fold accuracy, plus every test sample's true label, predicted
    label and kind ("clean", "noisy" or "healthy") pooled across all folds.
    """
    splitter = StratifiedKFold(n_splits=folds, shuffle=True, random_state=RANDOM_SEED)
    scores, y_true, y_pred, kinds = [], [], [], []
    for fold, (train_idx, test_idx) in enumerate(splitter.split(texts, labels)):
        X_tr, y_tr = augment([texts[i] for i in train_idx], [labels[i] for i in train_idx],
                             noise_pool, seed=RANDOM_SEED + fold)
        originals = [texts[i] for i in test_idx]
        X_te, y_te = augment(originals, [labels[i] for i in test_idx],
                             noise_pool, seed=RANDOM_SEED + 100 + fold)
        model = build_model().fit(X_tr, y_tr)
        predictions = predict_all(model, X_te)

        scores.append(accuracy_score(y_te, predictions))
        clean = set(originals)
        y_true += y_te
        y_pred += predictions
        kinds += ["healthy" if y == UNKNOWN_LABEL else "clean" if x in clean else "noisy"
                  for x, y in zip(X_te, y_te)]
    return {"scores": scores, "y_true": y_true, "y_pred": y_pred, "kinds": kinds}


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

    cv = cross_validate(texts, labels, noise_pool)
    scores, y_true, y_pred, kinds = cv["scores"], cv["y_true"], cv["y_pred"], cv["kinds"]

    # The spread across folds says how much to trust the mean: a wide range
    # means the score depends heavily on which incidents were held out.
    print(f"\n{FOLDS}-fold cross-validation ({len(y_true)} test samples, every incident tested once)")
    print("-" * 64)
    print("  per-fold accuracy: " + ", ".join(f"{s:.3f}" for s in scores))
    print(f"  mean {sum(scores) / len(scores):.3f}  (range {max(scores) - min(scores):.3f})")

    print("\nPer-category results, all folds pooled")
    print("-" * 64)
    print(classification_report(y_true, y_pred, zero_division=0))

    # The same test samples, split by kind. A model can look fine overall
    # while failing badly on exactly the noisy logs real users paste.
    print("Accuracy by kind of log")
    for kind, description in [("clean", "clean snippets"), ("noisy", "buried in noise"),
                              ("healthy", "healthy (unknown)")]:
        picked = [(t, p) for t, p, k in zip(y_true, y_pred, kinds) if k == kind]
        accuracy = accuracy_score([t for t, _ in picked], [p for _, p in picked])
        print(f"  {description:20}  {accuracy:.3f}  ({len(picked)})")

    print_confusion_matrix(y_true, y_pred, sorted(set(y_true)))

    # Retrain on ALL the data before saving. The folds existed to measure the
    # model honestly; now that we have our numbers, holding data back would
    # only make the shipped model worse. This is standard practice - evaluate
    # with cross-validation, ship a model trained on everything.
    all_texts, all_labels = augment(texts, labels, noise_pool, seed=RANDOM_SEED)
    final_model = build_model()
    final_model.fit(all_texts, all_labels)

    vocab_size = len(final_model.named_steps["tfidf"].get_feature_names_out())
    print(f"\nVocabulary learned: {vocab_size} features (words and word pairs)")
    show_top_features(final_model)

    joblib.dump(final_model, MODEL_PATH)
    print(f"\nSaved model -> {MODEL_PATH.name} (trained on {len(all_texts)} samples, "
          f"{len(final_model.named_steps['clf'].classes_)} categories)")

    evaluate_real_logs(final_model)


def evaluate_real_logs(model):
    """
    Score the shipped model on real logs it has never seen.

    Every number above comes from our own data - mostly hand-written, and noise
    added by our own code - so it can flatter the model. data/real_eval.jsonl
    holds log snippets copied verbatim from public GitHub issues, each with its
    source URL. They are NEVER used for training (not in DATA_PATHS), which is
    what makes this the closest thing we have to "how it does in production".
    """
    if not REAL_EVAL_PATH.exists():
        return
    rows = [json.loads(line) for line in REAL_EVAL_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]
    predictions = [predict_label(model, row["text"]) for row in rows]
    pairs = list(zip(predictions, rows))
    incidents = [(p, row) for p, row in pairs if row["label"] != UNKNOWN_LABEL]
    healthy = [(p, row) for p, row in pairs if row["label"] == UNKNOWN_LABEL]

    # Reported separately: an incident set this easy (found by searching for
    # the error text) would otherwise hide false alarms on healthy logs.
    print(f"\nReal logs from GitHub issues (never trained on)")
    print("-" * 64)
    print(f"  incidents correctly categorised   {sum(p == row['label'] for p, row in incidents)}/{len(incidents)}")
    print(f"  healthy logs with no prediction   {sum(p == UNKNOWN_LABEL for p, _ in healthy)}/{len(healthy)}")
    for p, row in pairs:
        if p != row["label"]:
            print(f"  {row['label']:24} -> {p:24} {row['source']}")


if __name__ == "__main__":
    main()
