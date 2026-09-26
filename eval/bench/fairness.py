"""Fairness pass: pick each question-based model's wording on the dev split.

Rule, fixed before running: highest mean of dev chunk AUC and dev user AUC. A wording must
beat w0 by more than TIE to replace it. Writes results/fairness.json.

Usage: venv/bin/python -m bench.fairness
"""

import json
from pathlib import Path

from . import metrics as m
from .detectors import WORDINGS

EVAL = Path(__file__).resolve().parents[1]
RAW = EVAL / "results" / "raw"
MODELS = ["jev", "kev-4b", "kev-0.8b", "laya"]
TIE = 0.005


def dev_auc(name: str, kind: str, cases: dict) -> float | None:
    path = RAW / f"{name}.jsonl"
    if not path.exists():
        return None
    pairs = [
        (cases[r["id"]]["label"], r["p"])
        for r in map(json.loads, path.read_text().splitlines())
        if "error" not in r and r["repeat"] == 0 and r["id"] in cases and cases[r["id"]]["kind"] == kind
    ]
    if not pairs:
        return None
    y, p = zip(*pairs)
    return m.auc(list(y), list(p))


def main() -> None:
    cases = {
        c["id"]: c
        for c in map(json.loads, (EVAL / "data" / "cases.jsonl").read_text().splitlines())
        if c["split"] == "dev"
    }
    out = {}
    print(f"{'model':<10} {'wording':<8} {'chunk AUC':>9} {'user AUC':>9} {'mean':>7}")
    for model in MODELS:
        scores = {}
        for w in WORDINGS:
            name = model if w == "w0" else f"{model}@{w}"
            chunk, user = dev_auc(name, "chunk", cases), dev_auc(name, "user", cases)
            if chunk is None or user is None:
                continue
            scores[w] = {"chunk_auc": chunk, "user_auc": user, "mean": (chunk + user) / 2}
            print(f"{model:<10} {w:<8} {chunk:>9.3f} {user:>9.3f} {scores[w]['mean']:>7.3f}")
        best = max(scores, key=lambda w: scores[w]["mean"])
        if best != "w0" and scores[best]["mean"] - scores["w0"]["mean"] <= TIE:
            best = "w0"
        out[model] = {"chosen": best, "dev": scores}
        print(f"{model:<10} -> {best}\n")
    (EVAL / "results" / "fairness.json").write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main()
