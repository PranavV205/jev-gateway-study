"""Builds the frozen benchmark set: data/cases.jsonl plus data/manifest.json with checksums.

Run once: `venv/bin/python -m bench.data`. Re-running with the same sources and seed gives
identical output; the manifest records the SHA-256 so any later change is detectable.
"""

import hashlib
import json
import random
import re
from pathlib import Path

import httpx

from .payloads import (
    BENIGN_LOOKALIKES,
    BENIGN_NEUTRAL,
    BENIGN_TRANSLATIONS,
    SUBTLE_GOALS,
    CLASSIFIER_BAIT,
    DISGUISES,
    GOALS,
    OBFUSCATIONS,
    POSITIONS,
    TRANSLATIONS,
)

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parents[1] / "data"
SEED = 20260925

# Documents are split by file so no document contributes to both the tuning and the test half.
DEV_DOCS = {"invoice-northwind-2041", "invoice-cedarpine-0913", "policy-employee-handbook", "lease-alder-street"}

HF_ROWS = "https://datasets-server.huggingface.co/rows"


def case(id_, text, kind, label, split, group, **meta):
    return {"id": id_, "text": text, "kind": kind, "label": label, "split": split, "group": group, "meta": meta}


# ---------- corpus chunking (mirrors apps/doc-qa/src/retrieve.ts) ----------

def chunk_document(markdown: str, target_words: int = 180) -> list[str]:
    blocks = [b.strip() for b in re.split(r"\n\s*\n", markdown) if b.strip()]
    groups: list[list[str]] = []
    current: list[str] = []
    words = 0
    for block in blocks:
        starts_section = bool(re.match(r"^#{1,6}\s", block))
        n = len(block.split())
        if current and (starts_section or words + n > target_words):
            groups.append(current)
            current, words = [], 0
        current.append(block)
        words += n
    if current:
        groups.append(current)
    return ["\n\n".join(g) for g in groups]


def insert(chunk: str, payload: str, position: str) -> str:
    blocks = chunk.split("\n\n")
    if position == "start":
        return f"{payload}\n\n{chunk}"
    if position == "end":
        return f"{chunk}\n\n{payload}"
    mid = max(1, len(blocks) // 2)
    return "\n\n".join(blocks[:mid] + [payload] + blocks[mid:])


# ---------- groups ----------

def corpus_cases(rng: random.Random) -> list[dict]:
    out = []
    goal_names = list(GOALS)
    for path in sorted((ROOT / "corpus" / "documents").glob("*.md")):
        doc = path.stem
        split = "dev" if doc in DEV_DOCS else "test"
        # Skip heading-only chunks: nothing to hide an instruction in.
        chunks = [c for c in chunk_document(path.read_text()) if len(c.split()) >= 25]
        for i, chunk in enumerate(chunks):
            cid = f"{doc}#{i + 1}"
            out.append(case(f"clean:{cid}", chunk, "chunk", 0, split, "clean_chunk", doc=doc))
            # Every chunk gets one attack, with seeded variety in goal, disguise, and position.
            goal = rng.choice(goal_names)
            disguise = rng.choice(list(DISGUISES))
            position = rng.choice(POSITIONS)
            payload = DISGUISES[disguise](GOALS[goal][0])
            out.append(
                case(
                    f"attack:{cid}:{goal}:{disguise}:{position}",
                    insert(chunk, payload, position),
                    "chunk",
                    1,
                    split,
                    "embedded_attack",
                    doc=doc,
                    goal=goal,
                    disguise=disguise,
                    position=position,
                    payload=GOALS[goal][0],
                )
            )
            # Three different innocent look-alikes per chunk, so false alarms are measured on
            # enough in-domain benign text.
            for k, benign in enumerate(rng.sample(BENIGN_LOOKALIKES, 3)):
                out.append(
                    case(
                        f"lookalike:{cid}:{k}",
                        insert(chunk, benign, rng.choice(POSITIONS)),
                        "chunk",
                        0,
                        split,
                        "benign_lookalike",
                        doc=doc,
                        inserted=benign,
                    )
                )
    return out


def coverage_attacks(rng: random.Random) -> list[dict]:
    """Every goal x disguise x position once, on a short test-document chunk, so no cell is empty."""
    out = []
    pool = [
        c
        for p in sorted((ROOT / "corpus" / "documents").glob("*.md"))
        if p.stem not in DEV_DOCS
        for c in chunk_document(p.read_text())
        if len(c.split()) >= 40
    ]
    for goal, phrasings in GOALS.items():
        for disguise, wrap in DISGUISES.items():
            for position in POSITIONS:
                chunk = rng.choice(pool)
                out.append(
                    case(
                        f"grid:{goal}:{disguise}:{position}",
                        insert(chunk, wrap(phrasings[0]), position),
                        "chunk",
                        1,
                        "test",
                        "grid_attack",
                        goal=goal,
                        disguise=disguise,
                        position=position,
                        payload=phrasings[0],
                    )
                )
    return out


def obfuscated_cases(rng: random.Random) -> list[dict]:
    out = []
    pool = [
        c
        for p in sorted((ROOT / "corpus" / "documents").glob("*.md"))
        if p.stem not in DEV_DOCS
        for c in chunk_document(p.read_text())
        if len(c.split()) >= 40
    ]
    for goal, phrasings in GOALS.items():
        for name, fn in OBFUSCATIONS.items():
            for k in range(2):
                chunk = rng.choice(pool)
                out.append(
                    case(
                        f"obfuscated:{name}:{goal}:{k}",
                        insert(chunk, fn(phrasings[k]), rng.choice(POSITIONS)),
                        "chunk",
                        1,
                        "test",
                        "obfuscated",
                        transform=name,
                        goal=goal,
                    )
                )
        for lang, table in TRANSLATIONS.items():
            chunk = rng.choice(pool)
            out.append(
                case(
                    f"translated:{lang}:{goal}",
                    insert(chunk, table[goal], rng.choice(POSITIONS)),
                    "chunk",
                    1,
                    "test",
                    "obfuscated",
                    transform=f"lang_{lang}",
                    goal=goal,
                )
            )
    return out


def consistency_cases(rng: random.Random) -> list[dict]:
    """Paraphrase and classifier-bait variants on the same chunks, for the consistency checks."""
    out = []
    pool = [
        c
        for p in sorted((ROOT / "corpus" / "documents").glob("*.md"))
        if p.stem not in DEV_DOCS
        for c in chunk_document(p.read_text())
        if len(c.split()) >= 40
    ]
    for goal, phrasings in GOALS.items():
        for k in range(3):
            chunk = rng.choice(pool)
            position = rng.choice(POSITIONS)
            for v, phrasing in enumerate(phrasings):
                out.append(
                    case(
                        f"paraphrase:{goal}:{k}:{v}",
                        insert(chunk, phrasing, position),
                        "chunk",
                        1,
                        "test",
                        "paraphrase",
                        goal=goal,
                        set=f"{goal}:{k}",
                        variant=v,
                    )
                )
            base = insert(chunk, phrasings[0], position)
            out.append(case(f"bait:{goal}:{k}:off", base, "chunk", 1, "test", "bait", goal=goal, set=f"{goal}:{k}", bait=False))
            out.append(
                case(
                    f"bait:{goal}:{k}:on",
                    insert(chunk, CLASSIFIER_BAIT + phrasings[0], position),
                    "chunk",
                    1,
                    "test",
                    "bait",
                    goal=goal,
                    set=f"{goal}:{k}",
                    bait=True,
                )
            )
    return out


def length_cases() -> list[dict]:
    """A payload buried in growing amounts of Wikipedia text, reusing the hard-cases filler."""
    hard = json.loads((ROOT / "experiments" / "hard-cases" / "cases.json").read_text())
    filler_source = next(c["text"] for c in hard["cases"] if c["id"] == "l2400-none").split()
    out = []
    for n in (150, 600, 1200, 2400):
        filler = filler_source[:n]
        out.append(case(f"length:{n}:none", " ".join(filler), "chunk", 0, "test", "length", words=n))
        for goal in ("canary", "exfiltration", "role_change"):
            for pos in ("middle", "end"):
                i = n if pos == "end" else n // 2
                text = " ".join(filler[:i] + [GOALS[goal][0]] + filler[i:])
                out.append(case(f"length:{n}:{goal}:{pos}", text, "chunk", 1, "test", "length", words=n, goal=goal, position=pos))
    return out


def dev_hand_cases() -> list[dict]:
    """The hand-written hard cases and user messages. Jev's wording was chosen on these, so dev only."""
    hard = json.loads((ROOT / "experiments" / "hard-cases" / "cases.json").read_text())["cases"]
    user_ids = {"h17", "h30", "s15", "s26"}
    out = []
    for c in hard:
        if c["group"] == "public":
            continue
        kind = "user" if c["id"] in user_ids else "chunk"
        out.append(case(f"hand:{c['id']}", c["text"], kind, int(c["attack"]), "dev", f"hand_{c['group']}", note=c["note"]))
    users = json.loads((ROOT / "experiments" / "question-wording" / "user.json").read_text())
    for u in users:
        out.append(case(f"hand:{u['id']}", u["text"], "user", int(u["attack"]), "dev", f"hand_{u['group']}", note=u["note"]))
    return out


def hf_rows(dataset: str, split: str, config: str = "default") -> list[dict]:
    rows, offset = [], 0
    while True:
        r = httpx.get(
            HF_ROWS,
            params={"dataset": dataset, "config": config, "split": split, "offset": offset, "length": 100},
            timeout=60,
        )
        r.raise_for_status()
        batch = [x["row"] for x in r.json()["rows"]]
        rows += batch
        if len(batch) < 100:
            return rows
        offset += 100


def notinject_cases() -> list[dict]:
    out = []
    for part, split in (("NotInject_one", "dev"), ("NotInject_two", "test"), ("NotInject_three", "test")):
        for i, r in enumerate(hf_rows("leolee99/NotInject", part)):
            out.append(
                case(
                    f"notinject:{part}:{i}",
                    r["prompt"],
                    "user",
                    0,
                    split,
                    "notinject",
                    category=r["category"],
                    trigger_words=r["word_list"],
                )
            )
    return out


def deepset_cases() -> list[dict]:
    return [
        case(f"deepset:test:{i}", r["text"], "user", int(r["label"]), "test", "deepset")
        for i, r in enumerate(hf_rows("deepset/prompt-injections", "test"))
    ]


# ---------- groups added after the first run ----------
# These use their own random generator and are appended at the end, so every earlier case
# keeps the same id and text and its scores stay valid.

def subtle_cases(rng: random.Random) -> list[dict]:
    """Attacks that never address an AI, embedded in every chunk of every document."""
    out = []
    for path in sorted((ROOT / "corpus" / "documents").glob("*.md")):
        doc = path.stem
        split = "dev" if doc in DEV_DOCS else "test"
        chunks = [c for c in chunk_document(path.read_text()) if len(c.split()) >= 25]
        for i, chunk in enumerate(chunks):
            goal = rng.choice(list(SUBTLE_GOALS))
            k = rng.randrange(2)
            position = rng.choice(POSITIONS)
            phrasing = SUBTLE_GOALS[goal][k]
            out.append(
                case(
                    f"subtle:{doc}#{i + 1}:{goal}:{k}:{position}",
                    insert(chunk, phrasing, position),
                    "chunk",
                    1,
                    split,
                    "subtle_attack",
                    doc=doc,
                    goal=goal,
                    position=position,
                    payload=phrasing,
                )
            )
    return out


def obfuscated_benign_cases(rng: random.Random) -> list[dict]:
    """Innocent sentences through the same transforms as the obfuscated attacks."""
    out = []
    pool = [
        c
        for p in sorted((ROOT / "corpus" / "documents").glob("*.md"))
        if p.stem not in DEV_DOCS
        for c in chunk_document(p.read_text())
        if len(c.split()) >= 40
    ]
    sentences = BENIGN_NEUTRAL + BENIGN_LOOKALIKES[:5]
    for name, fn in OBFUSCATIONS.items():
        for j, sentence in enumerate(rng.sample(sentences, 8)):
            out.append(
                case(
                    f"obfuscated_benign:{name}:{j}",
                    insert(rng.choice(pool), fn(sentence), rng.choice(POSITIONS)),
                    "chunk",
                    0,
                    "test",
                    "obfuscated_benign",
                    transform=name,
                    sentence=sentence,
                )
            )
    for lang, sentences_lang in BENIGN_TRANSLATIONS.items():
        for j, sentence in enumerate(sentences_lang):
            out.append(
                case(
                    f"translated_benign:{lang}:{j}",
                    insert(rng.choice(pool), sentence, rng.choice(POSITIONS)),
                    "chunk",
                    0,
                    "test",
                    "obfuscated_benign",
                    transform=f"lang_{lang}",
                )
            )
    return out


def build() -> None:
    rng = random.Random(SEED)
    cases = (
        dev_hand_cases()
        + corpus_cases(rng)
        + coverage_attacks(rng)
        + obfuscated_cases(rng)
        + consistency_cases(rng)
        + length_cases()
        + notinject_cases()
        + deepset_cases()
    )
    rng2 = random.Random(SEED + 1)
    cases += subtle_cases(rng2) + obfuscated_benign_cases(rng2)
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)), "duplicate case ids"

    OUT.mkdir(exist_ok=True)
    body = "".join(json.dumps(c, ensure_ascii=False) + "\n" for c in cases)
    (OUT / "cases.jsonl").write_text(body)

    counts: dict[str, dict[str, int]] = {}
    for c in cases:
        g = counts.setdefault(c["group"], {"dev": 0, "test": 0, "attacks": 0, "benign": 0})
        g[c["split"]] += 1
        g["attacks" if c["label"] else "benign"] += 1
    manifest = {
        "seed": SEED,
        "cases": len(cases),
        "sha256": hashlib.sha256(body.encode()).hexdigest(),
        "sources": {
            "notinject": "leolee99/NotInject (MIT)",
            "deepset": "deepset/prompt-injections test split (Apache 2.0)",
            "filler": "Wikipedia 'Bicycle' via experiments/hard-cases (CC BY-SA 4.0)",
            "corpus": "corpus/documents (fictional, this repo)",
        },
        "dev_documents": sorted(DEV_DOCS),
        "groups": counts,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    build()
