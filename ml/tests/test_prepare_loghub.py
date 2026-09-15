"""
Tests for prepare_loghub.py - above all, that noise carries no incident signal.

If a signal line leaked into noise_lines.txt it would appear in every category,
and the model would learn to ignore exactly the evidence it needs. That failure
is silent: training still succeeds, just with a worse model.
"""

import random
import tempfile
import unittest
from pathlib import Path

from prepare_loghub import SIGNAL_WORDS, incidents_from, noise_from, template_of

# One real-looking line per category. Each MUST be kept out of the noise.
SIGNAL_LINES = {
    "oom-killed": "kernel: Out of Memory: Killed process 2311 (python3)",
    "db-connection-refused": "connect ECONNREFUSED 127.0.0.1:27017",
    "disk-full": "write failed: No space left on device",
    "port-in-use": "listen EADDRINUSE: address already in use :::5000",
    "crash-loop": "Back-off restarting failed container api",
    "ssl-cert-expired": "x509: certificate has expired",
    "high-latency": "upstream timed out while reading response header",
    "error-rate-spike": "GET /api/orders 502 Bad Gateway",
    "dns-resolution-failure": "getaddrinfo ENOTFOUND mongo",
    "permission-denied": "open /data/app.log: Permission denied",
    "missing-config": "DATABASE_URL is not set",
    "too-many-open-files": "accept4: too many open files",
    "auth-brute-force": "sshd[24833]: Failed password for invalid user admin from 119.4.203.64",
    "kernel stack frame": "kernel:  [<c0144f6d>] mempool_alloc+0x2d/0xe0",
}

# Ordinary lines from the real Loghub files that SHOULD survive as noise.
HEALTHY_LINES = [
    "Dec 10 20:48:47 LabSZ sshd[19864]: Accepted password for curi from 137.189.241.19 port 5256 ssh2",
    "Jun  9 06:06:20 combo syslog: klogd startup succeeded",
    "Dec 10 09:32:20 LabSZ sshd[24680]: pam_unix(sshd:session): session opened for user fztu by (uid=0)",
    "[Thu Jun 09 06:07:04 2005] [notice] LDAP: Built with OpenLDAP LDAP SDK",
]


class SignalWordsTest(unittest.TestCase):
    def test_catches_every_category(self):
        for category, line in SIGNAL_LINES.items():
            with self.subTest(category=category):
                self.assertIsNotNone(SIGNAL_WORDS.search(line), f"would leak into noise: {line}")

    def test_keeps_ordinary_lines(self):
        for line in HEALTHY_LINES:
            with self.subTest(line=line):
                self.assertIsNone(SIGNAL_WORDS.search(line))


class TemplateOfTest(unittest.TestCase):
    def test_same_message_with_different_details_is_one_template(self):
        a = "Dec 12 01:27:30 LabSZ sshd[5606]: Accepted password for liuf from 52.80.34.196"
        b = "Jan  3 11:02:09 LabSZ sshd[77]: Accepted password for notes2 from 10.0.0.1"
        self.assertEqual(template_of(a), template_of(b))


class FileTestCase(unittest.TestCase):
    """Writes a small log file to a temp directory for each test."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write_log(self, lines):
        path = Path(self.tmp.name) / "test.log"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path


class NoiseFromTest(FileTestCase):
    def test_drops_signal_lines(self):
        path = self.write_log(HEALTHY_LINES + list(SIGNAL_LINES.values()))
        noise = noise_from(path, random.Random(1))
        self.assertCountEqual(noise, HEALTHY_LINES)

    def test_caps_repeats_of_one_message(self):
        # 500 copies of one message must not become 500 noise lines.
        lines = [f"Dec 10 20:48:{i % 60:02d} LabSZ sshd[{i}]: Accepted password for u{i}" for i in range(500)]
        noise = noise_from(self.write_log(lines), random.Random(1))
        self.assertLessEqual(len(noise), 10)


class IncidentsFromTest(FileTestCase):
    def test_windows_contain_the_marker_and_never_share_lines(self):
        lines = []
        for i in range(200):
            lines += [f"line {i}-a", f"line {i}-b", f"line {i}-c", f"kernel: Out of Memory: Killed process {i}"]
        incidents = incidents_from(self.write_log(lines), "Out of Memory", random.Random(1))

        self.assertGreater(len(incidents), 0)
        seen = set()
        for text in incidents:
            self.assertIn("Out of Memory", text)
            text_lines = set(text.split("\n"))
            self.assertFalse(seen & text_lines, "two incidents share a line - possible train/test leakage")
            seen |= text_lines

    def test_keeps_at_most_40_per_label(self):
        lines = [f"x {i}\nFailed password for root {i}" for i in range(2000)]
        incidents = incidents_from(self.write_log(lines), "Failed password", random.Random(1))
        self.assertEqual(len(incidents), 40)


if __name__ == "__main__":
    unittest.main()
