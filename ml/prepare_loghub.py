"""
Turn raw Loghub files into two small files the training code can use.

Setup (once): extract Apache.log, Linux.log and SSH.log from the Loghub
archives into ml/data/loghub/ (gitignored - SSH.log alone is 73 MB).

Run it with:    .venv/Scripts/python.exe prepare_loghub.py

Writes:
  data/noise_lines.txt        - real log lines with no incident signal, used by
                                augment.py to bury examples in realistic noise.
  data/loghub_incidents.jsonl - real incidents cut out of the logs:
                                out-of-memory kills from Linux.log ("oom-killed")
                                and SSH login attacks from SSH.log ("auth-brute-force").

Why a preparation step instead of reading Loghub during training: the raw files
are ~80 MB and change never. Distilling them once into a few hundred KB keeps
training fast, keeps the Docker image small, and lets the output be committed
and reviewed - you can open noise_lines.txt and check what the model will see.

Source: Loghub, https://github.com/logpai/loghub (free for research use).
"""

import json
import random
import re
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
RAW_DIR = HERE / "data" / "loghub"
NOISE_OUT = HERE / "data" / "noise_lines.txt"
INCIDENTS_OUT = HERE / "data" / "loghub_incidents.jsonl"

RANDOM_SEED = 42

# Noise must carry NO signal for any of our categories. If a line mentioning
# "Killed process" slipped into the noise, every category would contain OOM
# evidence and the model would learn to ignore it - the opposite of what we want.
# So anything touching a category's vocabulary is dropped, erring on the side of
# dropping too much: there are hundreds of thousands of lines to choose from.
SIGNAL_WORDS = re.compile(
    r"memory|oom|killed|out of|"                     # oom-killed
    r"refused|econn|no route|unreachable|"           # db-connection-refused
    r"disk|no space|enospc|quota|"                   # disk-full
    r"address already|eaddrinuse|bind|"              # port-in-use
    r"crash|restart|back-?off|exited|segfault|panic|fatal|"  # crash-loop
    r"certificate|cert|ssl|tls|x509|expired|"        # ssl-cert-expired
    r"time ?out|timed out|latency|slow|"             # high-latency
    r"\b5\d\d\b|internal server error|bad gateway|"  # error-rate-spike
    r"enotfound|eai_again|getaddrinfo|resolve|nxdomain|unknown host|"  # dns-resolution-failure
    r"permission|eacces|eperm|forbidden|not permitted|access denied|"  # permission-denied
    r"not set|not defined|missing|cannot find|not found|no such file|does not exist|"  # missing-config
    r"emfile|too many open|file descriptor|ulimit|"  # too-many-open-files
    # auth-brute-force. SSH.log is mostly login attacks, so this removes most of
    # it from the noise - those lines are now incidents, not background.
    r"failed password|invalid user|authentication fail|break-in|user unknown|preauth|max retries|"
    r"connect_to .* failed|"  # sshd failing to reach a host: a connection failure, not background
    # Kernel stack frames ("[<c0144f6d>] mempool_alloc"). In Linux.log these are
    # printed during the OOM crashes, so they are OOM evidence in disguise.
    r"\[<[0-9a-f]+>\]",
    re.IGNORECASE,
)

# The same message repeats thousands of times with only numbers, IPs or user
# names changed ("Directory index forbidden" appears 6,745 times in Apache.log).
# Keeping a few of each message, rather than a random sample of all lines, stops
# the most repetitive message from making up most of the noise.
PER_TEMPLATE = 10
NOISE_PER_SOURCE = 1500

# How many real incidents to keep per category. About the size of one
# hand-written category (40), so one data source cannot dominate a class.
INCIDENTS_PER_LABEL = 40

# (source file, the line that marks the incident, label to give it)
INCIDENT_SOURCES = [
    ("Linux.log", "Out of Memory: Killed process", "oom-killed"),
    ("SSH.log", "Failed password for", "auth-brute-force"),
]


def template_of(line):
    """
    A rough "message type" for a line: timestamp dropped, numbers masked, and
    only the first four words kept.

    'Dec 12 01:27:30 LabSZ sshd[5606]: Invalid user liuf from 52.80.34.196'
      -> 'LabSZ sshd[N]: Invalid user'

    Four words, because the variable part of a message (a user name, a path)
    usually comes after the fixed part. Masking only numbers left every user
    name as its own "type", and "Invalid user X" filled most of the SSH noise.
    """
    line = re.sub(r"^\[?[A-Z][a-z]{2} +[A-Za-z]* *\d+ [\d:]+( \d{4})?\]? ", "", line)
    return " ".join(re.sub(r"\d+", "N", line).split()[:4])


def noise_from(path, rng):
    """Up to NOISE_PER_SOURCE signal-free lines from one log, varied by template."""
    by_template = defaultdict(list)
    # Read line by line: SSH.log is 655,000 lines, no need to hold it all.
    with open(path, encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.strip()
            if not line or SIGNAL_WORDS.search(line):
                continue
            bucket = by_template[template_of(line)]
            if len(bucket) < PER_TEMPLATE:
                bucket.append(line)

    templates = list(by_template.values())
    rng.shuffle(templates)
    lines = [line for bucket in templates for line in bucket][:NOISE_PER_SOURCE]
    print(f"  {path.name}: {len(by_template)} message types -> {len(lines)} noise lines")
    return lines


def incidents_from(path, marker, rng):
    """
    Cut real incidents out of a log: every line containing `marker`, plus the
    lines leading up to it.

    That is what someone would actually paste - a stretch of log that ends in
    the problem. Windows never overlap, so two samples never share lines;
    otherwise one could land in training and its near-twin in the test set.
    """
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    marker_indices = [i for i, line in enumerate(lines) if marker in line]

    windows, last_end = [], -1
    for i in marker_indices:
        start = max(i - rng.randint(3, 15), 0)
        end = i + rng.randint(1, 4)  # a few lines after: failures come in bursts
        if start <= last_end:
            continue
        windows.append("\n".join(lines[start:end]))
        last_end = end

    # Take incidents spread across the whole file rather than the first 40,
    # which would all come from the same bad night.
    picked = rng.sample(windows, min(INCIDENTS_PER_LABEL, len(windows)))
    print(f"  {path.name}: {len(marker_indices)} marker lines -> {len(windows)} incidents -> kept {len(picked)}")
    return picked


def main():
    rng = random.Random(RANDOM_SEED)
    missing = [n for n in ("Apache.log", "Linux.log", "SSH.log") if not (RAW_DIR / n).exists()]
    if missing:
        raise SystemExit(f"Missing in {RAW_DIR}: {', '.join(missing)}. Extract the Loghub archives there first.")

    print("Noise lines")
    noise = []
    for name in ("Apache.log", "Linux.log", "SSH.log"):
        noise += noise_from(RAW_DIR / name, rng)
    rng.shuffle(noise)
    NOISE_OUT.write_text("\n".join(noise) + "\n", encoding="utf-8")

    print("Incidents")
    with open(INCIDENTS_OUT, "w", encoding="utf-8") as f:
        for name, marker, label in INCIDENT_SOURCES:
            for text in incidents_from(RAW_DIR / name, marker, rng):
                # "source" is ignored by train.py, but lets you tell real rows from
                # hand-written ones when reading the data or debugging a mistake.
                row = {"label": label, "text": text, "source": f"loghub-{name.removesuffix('.log').lower()}"}
                f.write(json.dumps(row) + "\n")

    print(f"\nWrote {NOISE_OUT.name} ({len(noise)} lines) and {INCIDENTS_OUT.name}")


if __name__ == "__main__":
    main()
