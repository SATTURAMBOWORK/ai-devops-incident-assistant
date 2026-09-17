"""
Tests for predict.py - the rules that turn window scores into one answer.

This is the file most worth protecting: train.py and main.py both depend on it,
and a quiet change here (a lower floor, "unknown" leaking out as a label) would
change what users see without any error.
"""

import pickle
import unittest

import predict
from predict import UNKNOWN_LABEL, classify, normalize, predict_label, windows
from tests.fakes import FakeModel, noise


class NormalizeTest(unittest.TestCase):
    def test_lowercases_and_masks_numbers(self):
        self.assertEqual(normalize("OOMKilled pid 4312"), "oomkilled pid  ")

    def test_keeps_meaningful_exit_and_status_codes(self):
        # 137 = killed (usually OOM), 503 = server error: real clues, not noise.
        self.assertEqual(normalize("exited with code 137, then 503"), "exited with code 137, then 503")

    def test_masks_ips_whole_so_no_fake_status_code_is_left(self):
        # Without IP masking first, "137.189.90.232" would leave a "137" behind.
        self.assertEqual(normalize("from 137.189.90.232:22 ok"), "from   ok")

    def test_drops_syslog_timestamp_and_hostname(self):
        # The hostname was a top feature for "unknown" before this was removed.
        self.assertEqual(
            normalize("Jun 10 11:31:45 combo kernel: Out of Memory\nDec  1 04:02:01 LabSZ sshd[42]: ok"),
            "kernel: out of memory\nsshd[ ]: ok",
        )

    def test_drops_apache_and_iso_timestamps(self):
        self.assertEqual(normalize("[Sat Jun 25 04:04:32 2005] [notice] up"), "[notice] up")
        self.assertEqual(normalize("2026-09-10T10:02:09Z api 504"), "api 504")

    def test_can_be_pickled_by_name(self):
        # The vectorizer inside model.joblib stores this function by reference.
        # A lambda here would make joblib.dump fail during training.
        self.assertIs(pickle.loads(pickle.dumps(normalize)), normalize)


class WindowsTest(unittest.TestCase):
    def test_short_log_is_one_window(self):
        self.assertEqual(windows("a\nb", size=3), ["a\nb"])

    def test_slides_one_line_at_a_time(self):
        self.assertEqual(windows("a\nb\nc\nd\ne", size=3), ["a\nb\nc", "b\nc\nd", "c\nd\ne"])

    def test_ignores_blank_lines(self):
        # Blank lines would otherwise make some windows hold fewer real lines.
        self.assertEqual(windows("a\n\n  \nb\nc", size=3), ["a\nb\nc"])


class ClassifyTest(unittest.TestCase):
    def setUp(self):
        self.model = FakeModel()

    def test_finds_an_error_buried_in_noise(self):
        # The whole point of windows: 1 bad line among 40 still wins.
        logs = "\n".join(noise(30) + ["State: OOMKilled"] + noise(10))
        self.assertEqual(classify(self.model, logs)[0], ("oom-killed", 0.90))

    def test_scores_all_windows_in_one_call(self):
        classify(self.model, "\n".join(noise(20)))
        self.assertEqual(len(self.model.windows_seen), 1)

    def test_healthy_log_returns_nothing(self):
        self.assertEqual(classify(self.model, "\n".join(noise(20))), [])

    def test_weak_guess_below_the_floor_returns_nothing(self):
        # WEAK_OOM beats "unknown" but is under MIN_CONFIDENCE.
        self.assertLess(0.38, predict.MIN_CONFIDENCE)
        self.assertEqual(classify(self.model, "maybe memory pressure"), [])

    def test_strongest_window_wins_across_the_log(self):
        logs = "\n".join(["no space left on device"] + noise(10) + ["OOMKilled"])
        self.assertEqual(classify(self.model, logs)[0][0], "oom-killed")

    def test_never_returns_unknown_as_a_label(self):
        logs = "\n".join(noise(5) + ["OOMKilled"])
        labels = [label for label, _ in classify(self.model, logs)]
        self.assertNotIn(UNKNOWN_LABEL, labels)

    def test_drops_runner_ups_below_the_alternative_floor(self):
        # disk-full at 0.04 is noise, not a meaningful "possibly X".
        self.assertEqual(classify(self.model, "oom-tiny"), [("oom-killed", 0.91)])

    def test_keeps_meaningful_runner_ups_best_first(self):
        result = classify(self.model, "no space left on device")
        self.assertEqual(result, [("disk-full", 0.80), ("oom-killed", 0.15)])

    def test_respects_top_k(self):
        self.assertEqual(len(classify(self.model, "no space left on device", top_k=1)), 1)


class PredictLabelTest(unittest.TestCase):
    def test_top_label_or_unknown(self):
        model = FakeModel()
        self.assertEqual(predict_label(model, "OOMKilled"), "oom-killed")
        self.assertEqual(predict_label(model, "all good"), UNKNOWN_LABEL)


if __name__ == "__main__":
    unittest.main()
