"""
Make the hand-written dataset look more like real logs.

Run it on its own to preview what it generates:
    .venv/Scripts/python.exe augment.py

The problem it solves: most examples in data/incidents.jsonl are clean 1-3 line
snippets containing only the error. Real incident logs are the error buried in
dozens of ordinary lines - logins, cron jobs, service notices. A model that only
ever saw clean snippets scores well in training and then meets noise for the
first time in production.

It does two things:
  1. add_noise()           - buries each example among ordinary log lines.
  2. make_unknown_sample() - produces logs that are ONLY ordinary lines, labelled
                             "unknown". Without this class the model must force
                             every input into one of the incident categories,
                             even perfectly healthy logs.

The ordinary lines are real: data/noise_lines.txt, distilled from Loghub's
Apache, Linux and SSH logs by prepare_loghub.py, with every line that mentions
an incident category filtered out.

This is a module, not a data file on purpose. train.py calls it AFTER splitting
the data, so noisy copies of one snippet can never land on both sides of the
train/test split - that would be leakage, and an inflated score.
"""

import random
from pathlib import Path

from predict import UNKNOWN_LABEL

DATA = Path(__file__).parent / "data"
# Real 2005-era lines from Loghub (Apache, Linux, SSH), written by prepare_loghub.py.
NOISE_PATH = DATA / "noise_lines.txt"
# Hand-written lines from today's stacks: Spring Boot, Node, Vite, nginx, Mongo,
# Postgres, Redis, Docker, Kubernetes, FastAPI, GitHub Actions. Loghub alone left
# the model with no idea what a NORMAL modern log looks like, and it called 3 of
# 6 real startup logs an incident. Both files are filtered the same way: no line
# may contain any category's vocabulary (see prepare_loghub.SIGNAL_WORDS).
MODERN_NOISE_PATH = DATA / "noise_lines_modern.txt"


def load_noise_lines(paths=(NOISE_PATH, MODERN_NOISE_PATH)):
    """
    The signal-free log lines to bury examples in.

    Fails loudly instead of silently training without noise: a model trained on
    clean snippets would still "work", just worse, and nobody would notice.
    """
    lines = []
    for path in paths:
        if not path.exists():
            raise SystemExit(f"{path} not found. Run prepare_loghub.py first.")
        lines += [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        raise SystemExit(f"No noise lines in {', '.join(p.name for p in paths)}.")
    return lines


def add_noise(text, noise_pool, rng, min_lines=5, max_lines=40):
    """
    Bury an incident snippet among ordinary lines.

    The snippet's own lines keep their order - in a real log the error message
    comes before the stack trace, not after - but noise can appear before,
    between and after them.
    """
    signal = text.split("\n")
    noise = rng.sample(noise_pool, rng.randint(min_lines, max_lines))

    # Pick sorted random positions in the noise to drop each signal line into.
    # Sorting is what preserves the snippet's line order.
    positions = sorted(rng.randint(0, len(noise)) for _ in signal)
    for offset, (pos, line) in enumerate(zip(positions, signal)):
        # +offset because each insert shifts every later position down by one.
        noise.insert(pos + offset, line)
    return "\n".join(noise)


def make_unknown_sample(noise_pool, rng, min_lines=5, max_lines=40):
    """A healthy log: nothing but ordinary lines."""
    return "\n".join(rng.sample(noise_pool, rng.randint(min_lines, max_lines)))


def augment(texts, labels, noise_pool, copies=3, seed=42):
    """
    Return a larger dataset: the originals, `copies` noisy versions of each, and
    a matching number of "unknown" samples.

    The clean originals are kept, because short, clean logs do happen - someone
    pastes just the error line - and the model should handle both.
    """
    rng = random.Random(seed)  # own seeded generator: same output every run
    out_texts, out_labels = [], []

    for text, label in zip(texts, labels):
        out_texts.append(text)
        out_labels.append(label)
        for _ in range(copies):
            out_texts.append(add_noise(text, noise_pool, rng))
            out_labels.append(label)

    # Give "unknown" as many samples as an average real category. Much fewer and
    # the model rarely predicts it; much more and it starts swallowing weak but
    # genuine incidents.
    per_class = round(len(out_texts) / len(set(labels)))
    for _ in range(per_class):
        out_texts.append(make_unknown_sample(noise_pool, rng))
        out_labels.append(UNKNOWN_LABEL)

    return out_texts, out_labels


if __name__ == "__main__":
    pool = load_noise_lines()
    rng = random.Random(7)
    print("--- noisy oom-killed example ---")
    print(add_noise("container exited with code 137\ndocker inspect api: State.OOMKilled: true", pool, rng, 6, 10))
    print("\n--- unknown example ---")
    print(make_unknown_sample(pool, rng, 6, 10))
