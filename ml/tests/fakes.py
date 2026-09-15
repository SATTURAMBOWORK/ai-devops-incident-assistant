"""
A stand-in for the trained model, for tests.

A real model's probabilities shift whenever the dataset changes, so tests on it
would break for reasons unrelated to the code under test. This fake returns
fixed probabilities decided by keywords, which lets a test say exactly "this
window is a confident OOM" or "this window is a weak guess" - and check that
predict.py makes the right decision with it.

It has the two things predict.py uses: named_steps["clf"].classes_ and
predict_proba(). Same idea as backend/tests/helpers/fakes.js.
"""

import numpy as np

CLASSES = ["disk-full", "oom-killed", "unknown"]

# Probability rows, in CLASSES order.
CONFIDENT_OOM = [0.05, 0.90, 0.05]
CONFIDENT_DISK = [0.80, 0.15, 0.05]
# Beats "unknown", but below predict.MIN_CONFIDENCE (0.40).
WEAK_OOM = [0.25, 0.38, 0.37]
# OOM wins; disk-full is a runner-up below MIN_ALTERNATIVE_CONFIDENCE (0.10).
OOM_TINY_RUNNER_UP = [0.04, 0.91, 0.05]
HEALTHY = [0.05, 0.05, 0.90]


class FakeModel:
    def __init__(self):
        clf = type("Classifier", (), {"classes_": np.array(CLASSES)})()
        self.named_steps = {"clf": clf}
        self.windows_seen = []

    def predict_proba(self, texts):
        self.windows_seen.append(list(texts))
        return np.array([self._row(text) for text in texts])

    @staticmethod
    def _row(text):
        if "OOMKilled" in text:
            return CONFIDENT_OOM
        if "no space left" in text:
            return CONFIDENT_DISK
        if "maybe memory" in text:
            return WEAK_OOM
        if "oom-tiny" in text:
            return OOM_TINY_RUNNER_UP
        return HEALTHY


def noise(count):
    return [f"INFO request {i} served" for i in range(count)]
