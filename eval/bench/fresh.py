"""Builds the fresh held-out set: data/fresh.jsonl, data/fresh-ids.json, data/fresh-manifest.json.

Nothing in it was written by this repo's author, and nothing is tuned on it.

The Enron emails are real people's messages, so the text is not committed: fresh.jsonl is
rebuilt locally from the public sources, and fresh-ids.json records which rows were used.

- Attacks: human-written emails from Microsoft's LLMail-Inject challenge, Phase 2 (MIT), that
  actually hijacked the email assistant (`exfil.sent`). Split by whether Microsoft's defenses
  caught them (`defense.undetected`). At most PER_TEAM per team and no near-duplicates, so a
  few prolific teams can't dominate.
- Benign: real business emails from the Enron corpus (LLM-PBE/enron-email, Apache 2.0).

Run: venv/bin/python -m bench.fresh
"""

import hashlib
import json
import random
import re
from pathlib import Path

import httpx
import pyarrow.parquet as pq

EVAL = Path(__file__).resolve().parents[1]
CACHE = EVAL / ".cache"
OUT = EVAL / "data"
SEED = 20260926
PER_GROUP = 200
PER_TEAM = 4
BENIGN = 400

SOURCES = {
    "llmail-phase2.parquet": "https://huggingface.co/api/datasets/microsoft/llmail-inject-challenge/parquet/default/Phase2/0.parquet",
    "enron-0.parquet": "https://huggingface.co/api/datasets/LLM-PBE/enron-email/parquet/default/train/0.parquet",
}


def fetch() -> None:
    CACHE.mkdir(exist_ok=True)
    for name, url in SOURCES.items():
        path = CACHE / name
        if not path.exists():
            with httpx.stream("GET", url, follow_redirects=True, timeout=600) as r:
                r.raise_for_status()
                with path.open("wb") as f:
                    for chunk in r.iter_bytes():
                        f.write(chunk)


def norm(text: str) -> str:
    """For near-duplicate detection: lowercase, letters and digits only."""
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def email_text(subject: str, body: str) -> str:
    return f"Subject: {subject.strip()}\n\n{body.strip()}" if subject and subject.strip() else body.strip()


def attacks(rng: random.Random) -> list[dict]:
    rows = pq.read_table(CACHE / "llmail-phase2.parquet", columns=["RowKey", "body", "subject", "objectives", "scenario", "team_id"]).to_pylist()
    pools: dict[bool, list[dict]] = {True: [], False: []}
    for r in rows:
        o = json.loads(r["objectives"])
        n_words = len((r["body"] or "").split())
        if o.get("exfil.sent") and 10 <= n_words <= 800:
            pools[bool(o.get("defense.undetected"))].append(r)

    out = []
    for undetected, pool in pools.items():
        rng.shuffle(pool)
        per_team: dict[str, int] = {}
        seen: set[str] = set()
        group = "llmail_evaded_ms" if undetected else "llmail_caught_by_ms"
        for r in pool:
            key = norm(r["body"])[:400]
            if key in seen or per_team.get(r["team_id"], 0) >= PER_TEAM:
                continue
            seen.add(key)
            per_team[r["team_id"]] = per_team.get(r["team_id"], 0) + 1
            out.append(
                {
                    "id": f"llmail:{r['RowKey']}",
                    "text": email_text(r["subject"], r["body"]),
                    "kind": "chunk",
                    "label": 1,
                    "split": "fresh",
                    "group": group,
                    "meta": {"team": r["team_id"], "scenario": r["scenario"]},
                }
            )
            if sum(1 for c in out if c["group"] == group) >= PER_GROUP:
                break
    return out


def benign(rng: random.Random) -> list[dict]:
    texts = pq.read_table(CACHE / "enron-0.parquet").column("text").to_pylist()
    rows = list(enumerate(texts))
    rng.shuffle(rows)
    out, seen = [], set()
    for row_index, text in rows:
        text = text.strip()
        n_words = len(text.split())
        key = norm(text)[:400]
        # Similar length range to the attacks; skip empties, duplicates, and long threads.
        if not 30 <= n_words <= 600 or key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "id": f"enron:{hashlib.sha256(text.encode()).hexdigest()[:16]}",
                "text": text,
                "kind": "chunk",
                "label": 0,
                "split": "fresh",
                "group": "enron_benign",
                "meta": {"source_row": row_index},
            }
        )
        if len(out) >= BENIGN:
            break
    return out


def build() -> None:
    fetch()
    rng = random.Random(SEED)
    cases = attacks(rng) + benign(rng)
    case_ids = [c["id"] for c in cases]
    assert len(case_ids) == len(set(case_ids)), "duplicate ids"
    body = "".join(json.dumps(c, ensure_ascii=False) + "\n" for c in cases)
    (OUT / "fresh.jsonl").write_text(body)
    id_list = [
        {
            "id": c["id"],
            "group": c["group"],
            "label": c["label"],
            "source": "enron-email shard 0" if c["group"] == "enron_benign" else "llmail-inject Phase2",
            "source_row": c["meta"].get("source_row", c["id"].removeprefix("llmail:")),
        }
        for c in cases
    ]
    (OUT / "fresh-ids.json").write_text(json.dumps(id_list, indent=1) + "\n")
    counts: dict[str, int] = {}
    for c in cases:
        counts[c["group"]] = counts.get(c["group"], 0) + 1
    manifest = {
        "seed": SEED,
        "cases": len(cases),
        "sha256_of_fresh_jsonl": hashlib.sha256(body.encode()).hexdigest(),
        "groups": counts,
        "teams": len({c["meta"]["team"] for c in cases if c["label"] == 1}),
        "sources": {
            "attacks": "microsoft/llmail-inject-challenge, Phase2, exfil.sent = true (MIT)",
            "benign": "LLM-PBE/enron-email, shard 0 (Apache 2.0)",
        },
        "rules": f"at most {PER_TEAM} attacks per team, near-duplicates removed, 10-800 word attacks, 30-600 word emails",
    }
    (OUT / "fresh-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    build()
