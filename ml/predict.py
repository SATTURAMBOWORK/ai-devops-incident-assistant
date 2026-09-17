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


# Log line prefixes that say WHEN and WHERE, never WHAT went wrong. Left in,
# they become features: the training noise is 85% from one Linux server, so
# its hostname "combo" and month names were the top words for "unknown" - the
# model was partly learning "this server = healthy". Removed per line (re.M),
# after lower-casing:
#   syslog   "jun 10 11:31:45 combo kernel: ..."      -> "kernel: ..."
#   apache   "[sat jun 25 04:04:32 2005] [notice] ..." -> "[notice] ..."
#   iso      "2026-09-10t10:02:09z api-1 ..."          -> "api-1 ..."
LINE_PREFIX = re.compile(
    r"^\s*(?:"
    r"[a-z]{3} +\d{1,2} \d\d:\d\d:\d\d \S+ +"                  # syslog: date, time, host
    r"|\[[a-z]{3} [a-z]{3} +\d{1,2} [\d:]+ \d{4}\] +"            # apache: [day month dd time yyyy]
    r"|\d{4}-\d\d-\d\dt[\d:.]+(?:z|[+-]\d\d:?\d\d)? +"        # iso 8601
    r")",
    re.MULTILINE,
)

# IPs (with an optional port) go before the number rule, so "137.189.90.232"
# cannot leave a "137" behind that looks like the OOM exit code.
IP_ADDRESS = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b")

# The few numbers that MEAN something, kept as words. Masking every number hid
# the strongest clue some categories have:
#   137 SIGKILL (usually the OOM killer), 139 SIGSEGV, 143 SIGTERM
#   HTTP status codes: 401/403 auth, 404 missing, 429 rate limit, 5xx server errors
MEANINGFUL_NUMBERS = frozenset(
    {"137", "139", "143", "401", "403", "404", "429", "500", "502", "503", "504"}
)
NUMBER = re.compile(r"\d+")

# A duration of a second or more becomes the word "slowduration"; shorter ones
# are masked like any number. Masking alone turned "took 8400ms" and "took 12ms"
# into the same "took ms", so high-latency logs - whose only clue is often a big
# number - looked healthy: recall was 0.45, mostly lost to "unknown". The one
# token raised it to 0.57, and to 0.83 together with more examples. One second
# is the line; 2s scored slightly worse, and a "fastduration" token added nothing.
DURATION_UNITS = {
    "ms": 0.001, "msec": 0.001, "millisecond": 0.001, "milliseconds": 0.001,
    "s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
    "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "hour": 3600, "hours": 3600,
}
# Longest units first, so "ms" is not read as "m" + "s". No bare "m" or "h":
# "3.2m documents" is not minutes, and in `kubectl get pods` the AGE column
# ("24h", "3h25m") turned a crash-loop pod list into a latency incident on a
# real log from GitHub.
DURATION = re.compile(
    r"(\d+(?:\.\d+)?) ?(" + "|".join(sorted(DURATION_UNITS, key=len, reverse=True)) + r")\b"
)
SLOW_SECONDS = 1.0


def _duration_word(match):
    seconds = float(match.group(1)) * DURATION_UNITS[match.group(2)]
    return " slowduration " if seconds >= SLOW_SECONDS else " "


def normalize(text):
    """
    Clean a log for the vectorizer: lower-case, drop timestamp/host prefixes,
    mask IPs, turn long durations into "slowduration", and replace every other
    number with a space except MEANINGFUL_NUMBERS.

    Timestamps, PIDs, ports and IPs are different in every log, so as features
    they only let the model memorise individual training examples.

    It is a named module-level function, not a lambda, because the vectorizer is
    saved inside model.joblib and pickle can only store functions it can import
    again by name - which is also why main.py must be able to import this file.
    """
    text = LINE_PREFIX.sub("", text.lower())
    text = IP_ADDRESS.sub(" ", text)
    text = DURATION.sub(_duration_word, text)
    return NUMBER.sub(lambda m: m.group() if m.group() in MEANINGFUL_NUMBERS else " ", text)


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
