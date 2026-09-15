"""
How a trained model turns a whole log into an answer.

Both train.py (to measure the model) and main.py (to serve it) import this
file. If they each had their own copy of this logic, the accuracy printed during
training would describe a different model from the one users actually get.

Why windows instead of classifying the whole log at once:
TF-IDF turns a log into one bag of words. In a 40-line log where three lines are
the error, those three lines are diluted by the other 37 - measured on held-out
data, accuracy on errors buried in noise was 46%. A person reading a log does
not average it; they scan for the bad lines. So we score every 3-line window
separately and keep the strongest incident signal found anywhere in the log.
That raised accuracy on noisy logs to 69%, and on healthy logs (correctly
answering "unknown") from 53% to 86%.
"""

import re

import numpy as np

UNKNOWN_LABEL = "unknown"

# Lines per window. Most incident signatures are 1-3 lines (an error plus a
# stack frame or exit code). Tested 3, 5 and 10 on held-out data: bigger windows
# let noise dilute the signal again, which is the problem windows exist to fix.
WINDOW_LINES = 3

# The winning window must be at least this sure, or the answer is "unknown".
# The trade-off, measured on held-out data: 0.30 gets 74% of noisy incidents
# right but only 39% of healthy logs; 0.40 gets 69% and 86%; 0.50 gets 62% and
# 97%. 0.40 is where false alarms become rare without hiding most real
# incidents - an engineer sent to the wrong runbook loses more time than one
# given no hint.
MIN_CONFIDENCE = 0.40

# Runners-up below this are noise, not a meaningful "possibly X".
MIN_ALTERNATIVE_CONFIDENCE = 0.10


def normalize(text):
    """
    Lower-case and replace every number with a space. Used by the vectorizer.

    Timestamps, PIDs, ports and IPs are different in every log, so as features
    they only let the model memorise individual training examples. Masking them
    made the model score better on logs it had never seen.

    It is a named module-level function, not a lambda, because the vectorizer is
    saved inside model.joblib and pickle can only store functions it can import
    again by name - which is also why main.py must be able to import this file.
    """
    return re.sub(r"\d+", " ", text.lower())


def windows(text, size=WINDOW_LINES):
    """Every run of `size` consecutive non-blank lines (the whole log if shorter)."""
    lines = [line for line in text.split("\n") if line.strip()]
    if len(lines) <= size:
        return ["\n".join(lines)]
    return ["\n".join(lines[i:i + size]) for i in range(len(lines) - size + 1)]


def classify(model, text, top_k=3):
    """
    Rank incident categories for a log.

    Returns [(label, confidence), ...], best first - or [] when the log looks
    healthy or no window is confident enough. "unknown" is never returned as a
    label: to the caller it means "no prediction", and an empty list says that
    without anyone downstream needing to know the word.
    """
    classes = list(model.named_steps["clf"].classes_)
    unknown = classes.index(UNKNOWN_LABEL)

    # One predict_proba call for all windows: rows = windows, columns = classes.
    probs = model.predict_proba(windows(text))

    # Only windows where some incident beats "unknown" count as evidence.
    # Without this, a healthy log's 0.2 "maybe oom" in every window would still
    # produce an answer.
    is_incident = probs.argmax(axis=1) != unknown
    if not is_incident.any():
        return []

    candidates = probs[is_incident].copy()
    candidates[:, unknown] = -1  # never pick "unknown" as the winner

    # The single strongest (window, category) pair anywhere in the log. That
    # window's row is the answer: its winner, plus its own runners-up.
    best_window, best_class = np.unravel_index(candidates.argmax(), candidates.shape)
    if candidates[best_window, best_class] < MIN_CONFIDENCE:
        return []

    row = candidates[best_window]
    ranked = sorted(
        ((classes[i], float(row[i])) for i in range(len(classes)) if i != unknown),
        key=lambda pair: pair[1],
        reverse=True,
    )
    return [
        (label, confidence)
        for rank, (label, confidence) in enumerate(ranked[:top_k])
        if rank == 0 or confidence >= MIN_ALTERNATIVE_CONFIDENCE
    ]


def predict_label(model, text):
    """The single answer for evaluation: the top category, or "unknown"."""
    ranked = classify(model, text, top_k=1)
    return ranked[0][0] if ranked else UNKNOWN_LABEL
