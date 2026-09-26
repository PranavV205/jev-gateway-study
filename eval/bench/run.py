"""Scores benchmark cases with one detector and appends raw results to results/raw/<name>.jsonl.

Usage: venv/bin/python -m bench.run <detector> [--split dev|test|all] [--repeat N] [--limit N]

Runs are resumable: a case already scored (same id and repeat index) is skipped, so an
interrupted run continues where it stopped and nothing is paid for twice.
"""

import argparse
import asyncio
import datetime
import json
import sys
import time
from pathlib import Path

from . import detectors as d

EVAL = Path(__file__).resolve().parents[1]
RAW = EVAL / "results" / "raw"


def make(name: str) -> d.Detector:
    """`name` may carry a wording from the fairness-pass menu, as in `kev-4b@w2`."""
    d.load_env()
    name, _, wording = name.partition("@")
    wording = wording or "w0"
    if name == "jev":
        return d.jev(wording)
    if name.startswith("kev-"):
        # One local Kev server per size: 0.8b on port 8009, 4b on 8011.
        size = name.removeprefix("kev-")
        return d.kev(size, {"0.8b": 8009, "4b": 8011}[size], wording)
    if name == "laya":
        return d.Laya(wording)
    if name.startswith("gliner-"):
        return d.Gliner(name.removeprefix("gliner-"))
    if name == "protectai-deberta":
        return d.ProtectAI()
    if name == "promptguard2":
        return d.PromptGuard()
    if name == "keywords":
        return d.Keywords()
    raise SystemExit(f"unknown detector {name}")


def load_cases(split: str) -> list[dict]:
    cases = [json.loads(line) for line in (EVAL / "data" / "cases.jsonl").read_text().splitlines()]
    return cases if split == "all" else [c for c in cases if c["split"] == split]


def done_keys(path: Path) -> set[tuple[str, int]]:
    if not path.exists():
        return set()
    keys = set()
    for line in path.read_text().splitlines():
        r = json.loads(line)
        if "error" not in r:
            keys.add((r["id"], r["repeat"]))
    return keys


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("detector")
    ap.add_argument("--split", default="all", choices=["dev", "test", "all"])
    ap.add_argument("--repeat", type=int, default=1, help="score each case N times (determinism check)")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    det = make(args.detector)
    RAW.mkdir(parents=True, exist_ok=True)
    out_path = RAW / f"{det.name}.jsonl"
    done = done_keys(out_path)
    todo = [(c, k) for c in load_cases(args.split) for k in range(args.repeat) if (c["id"], k) not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{det.name}: {len(todo)} to score ({len(done)} already done)", file=sys.stderr)

    sem = asyncio.Semaphore(det.concurrency)
    lock = asyncio.Lock()
    started = time.monotonic()
    finished = 0

    async def one(c: dict, k: int) -> None:
        nonlocal finished
        async with sem:
            row = {"id": c["id"], "repeat": k, "detector": det.name, "at": datetime.datetime.now(datetime.UTC).isoformat()}
            try:
                r = await det.score(c["text"], c["kind"])
                row.update(p=r["p"], latency_ms=round(r["latency_ms"], 1), cost_usd=r["cost_usd"], raw=r["raw"])
            except Exception as e:  # noqa: BLE001 - record and keep going; failures are data too
                row["error"] = f"{type(e).__name__}: {e}"[:500]
        async with lock:
            with out_path.open("a") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
            finished += 1
            if finished % 50 == 0 or finished == len(todo):
                rate = finished / max(1e-9, time.monotonic() - started)
                print(f"  {finished}/{len(todo)}  {rate:.1f}/s", file=sys.stderr)

    await asyncio.gather(*(one(c, k) for c, k in todo))


if __name__ == "__main__":
    asyncio.run(main())
