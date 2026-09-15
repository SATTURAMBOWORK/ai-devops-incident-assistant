"""Tests for augment.py - how the training set is grown."""

import random
import unittest
from collections import Counter
from pathlib import Path

from augment import add_noise, augment, load_noise_lines
from predict import UNKNOWN_LABEL
from tests.fakes import noise

POOL = noise(100)


class AddNoiseTest(unittest.TestCase):
    def test_keeps_every_signal_line_in_order(self):
        # An error must still come before its stack trace after augmentation.
        signal = ["Error: boom", "  at first", "  at second"]
        result = add_noise("\n".join(signal), POOL, random.Random(3)).split("\n")
        self.assertEqual([line for line in result if line in signal], signal)
        self.assertGreater(len(result), len(signal))


class AugmentTest(unittest.TestCase):
    def setUp(self):
        self.texts = ["disk a", "disk b", "oom a", "oom b"]
        self.labels = ["disk-full", "disk-full", "oom-killed", "oom-killed"]

    def test_keeps_originals_and_adds_noisy_copies(self):
        texts, labels = augment(self.texts, self.labels, POOL, copies=3)
        for original in self.texts:
            self.assertIn(original, texts)
        counts = Counter(labels)
        self.assertEqual(counts["disk-full"], 2 * 4)  # each original + 3 copies
        self.assertEqual(counts["oom-killed"], 2 * 4)

    def test_adds_unknown_like_an_average_category(self):
        _, labels = augment(self.texts, self.labels, POOL, copies=3)
        self.assertEqual(Counter(labels)[UNKNOWN_LABEL], 8)

    def test_same_seed_same_data(self):
        # Otherwise accuracy would change between runs with no code change.
        self.assertEqual(augment(self.texts, self.labels, POOL, seed=5),
                         augment(self.texts, self.labels, POOL, seed=5))


class LoadNoiseLinesTest(unittest.TestCase):
    def test_missing_file_stops_training_loudly(self):
        # Silently training without noise would ship a worse model unnoticed.
        with self.assertRaises(SystemExit):
            load_noise_lines(Path("does/not/exist.txt"))


if __name__ == "__main__":
    unittest.main()
