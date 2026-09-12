"""
Train the log -> runbook category classifier.

Run it with:    .venv/Scripts/python.exe train.py

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
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.pipeline import Pipeline

# Paths are relative to this file, not to the shell's working directory, so the
# script works no matter where you run it from.
HERE = Path(__file__).parent
DATA_PATH = HERE / "data" / "incidents.jsonl"
MODEL_PATH = HERE / "model.joblib"

# Fixing the random seed makes the train/test split identical on every run.
# Without it, your accuracy would jump around between runs and you could never
# tell whether a change to the model helped or you just got a luckier split.
RANDOM_SEED = 42

# Fraction of the data held back for testing. 0.2 of 112 rows is 22 samples -
# small, which is exactly why we also cross-validate further down.
TEST_SIZE = 0.2


def load_dataset(path):
    """Read the JSONL dataset into two parallel lists: texts and labels."""
    texts, labels = [], []
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
        # Logs are written in every case style (OOMKilled, oomkilled, OOM). Lower
        # casing collapses those into one feature instead of three rare ones.
        lowercase=True,
        # Unigrams alone lose word order: "no space left" and "space" mean
        # different things. Adding bigrams keeps pairs like "address already",
        # "connection refused", "heap limit" as single features - and those
        # pairs are exactly what distinguishes our categories.
        ngram_range=(1, 2),
        # Our dataset has 112 rows, so a term appearing twice is already a
        # signal. Raising this would throw away the rare error codes (ENOSPC,
        # EADDRINUSE) that are the most discriminative features we have.
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
        # the training data harder. With only 112 rows and thousands of features
        # the model could memorise everything, so we keep the default 1.0, which
        # regularises fairly strongly and pushes it toward general patterns.
        C=1.0,
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
    print(f"{'':24}" + "".join(f"{c:>8}" for c in codes))
    for label, row in zip(labels, matrix):
        print(f"  {label:22}" + "".join(f"{v:>8}" for v in row))


def main():
    texts, labels = load_dataset(DATA_PATH)
    print(f"Loaded {len(texts)} samples across {len(set(labels))} categories")

    # stratify=labels keeps the class proportions identical in both halves.
    # Without it, a random split of such a small dataset could easily leave a
    # category with zero test samples - and you would be scoring a model on
    # classes you never checked.
    X_train, X_test, y_train, y_test = train_test_split(
        texts,
        labels,
        test_size=TEST_SIZE,
        random_state=RANDOM_SEED,
        stratify=labels,
    )
    print(f"Split: {len(X_train)} training samples, {len(X_test)} test samples")

    model = build_model()
    model.fit(X_train, y_train)

    vocab_size = len(model.named_steps["tfidf"].get_feature_names_out())
    print(f"Vocabulary learned: {vocab_size} features (words and word pairs)")

    # The real score: predictions on rows the model has never seen.
    y_pred = model.predict(X_test)

    print("\nHeld-out test set results")
    print("-" * 64)
    # zero_division=0 keeps the report readable when a tiny test set happens to
    # give some class no predictions at all.
    print(classification_report(y_test, y_pred, zero_division=0))

    print_confusion_matrix(y_test, y_pred, sorted(set(labels)))

    # A 22-sample test set is small enough that one lucky or unlucky split can
    # move accuracy by several points. 5-fold cross-validation retrains the
    # model five times, each time holding out a different fifth, so every row
    # gets tested exactly once. The spread across folds tells you how much to
    # trust the single number above.
    scores = cross_val_score(build_model(), texts, labels, cv=5)
    print("\n5-fold cross-validation")
    print("-" * 64)
    print("  per-fold accuracy: " + ", ".join(f"{s:.3f}" for s in scores))
    print(f"  mean {scores.mean():.3f}  (+/- {scores.std() * 2:.3f})")

    show_top_features(model)

    # Retrain on ALL the data before saving. The split existed to measure the
    # model honestly; now that we have our number, throwing away 20% of a small
    # dataset would only make the shipped model worse. This is standard practice
    # - evaluate on a split, ship a model trained on everything.
    final_model = build_model()
    final_model.fit(texts, labels)
    joblib.dump(final_model, MODEL_PATH)
    print(f"\nSaved model -> {MODEL_PATH.name} (trained on all {len(texts)} samples)")


if __name__ == "__main__":
    main()
