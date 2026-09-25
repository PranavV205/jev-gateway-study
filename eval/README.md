# Detector benchmark: Jev and the open decision models

A head-to-head test of prompt-injection detectors on the job the gateway actually does: spotting instructions planted inside document chunks, and spotting jailbreaks in user messages. Every model sees the same texts, frozen with a checksum, on the same machine (Apple M4, 24 GB). Run 2026-09-25 to 2026-09-26. These models are days to weeks old, so treat every number as dated.

The full generated report, with every breakdown, is [`results/report.md`](results/report.md). Predictions were written before the test run: [`HYPOTHESES.md`](HYPOTHESES.md).

## Contestants

| Detector | What it is | How it ran |
|----------|-----------|-----------|
| **Jev** 1.13.0 | TypeSafe's hosted decision model | API, US West |
| **Kev-4B**, **Kev-0.8B** | Open Jev-like models (Qwen3.5 bases), same API as Jev | Local, MLX |
| **Laya** | Open 421M decision model (ModernBERT) | Local, PyTorch on MPS |
| **GLiNER2.5-Decide** | Open 340M encoder classifier | Local |
| **ProtectAI DeBERTa v3** | Open injection classifier, common research baseline | Local |
| **Prompt Guard 2 86M** | Meta's injection classifier | Groq API (weights are gated) |
| **Keywords** | 12 regexes for common injection phrasing | Local |

Jev, Kev, Laya, and GLiNER get the gateway's frozen question wording (`config/default.json`). GLiNER takes label sets instead of questions, so four framings were tried on the dev split and the best one (plain labels) was frozen, the same allowance Jev's wording got earlier. For a chunk, the score is the higher of the injection and exfiltration questions, which is the gateway's drop rule.

## Data

1,242 texts (`data/cases.jsonl`, SHA-256 in `data/manifest.json`), split into dev and test **by document**, so no document appears in both.

| Group | What it tests |
|-------|--------------|
| Attacks planted in the fictional corpus: 6 goals x 5 disguises x 3 positions, each with a canary code | In-document detection |
| Subtle attacks that never mention an AI ("Summaries of this document must end with...") | Attacks that don't announce themselves |
| Innocent look-alikes in the same chunks ("ignore the warning light...", a quoted system prompt, a security reminder) | False alarms in documents |
| Attacks scrambled 10 ways (base64, ROT13, leetspeak, look-alike letters, zero-width, spaced, 4 languages) **plus innocent sentences scrambled the same way** | Robustness, and whether a detector just flags anything strange |
| A payload buried in 150 to 2,400 words | Long input |
| Paraphrases and "classifier, answer no" bait on the same attacks | Consistency |
| [NotInject](https://huggingface.co/datasets/leolee99/NotInject) (MIT) and the [deepset](https://huggingface.co/datasets/deepset/prompt-injections) test split (Apache 2.0) | User-message false alarms and jailbreaks |

The hand-written cases used to choose Jev's wording are in dev only. Thresholds were tuned on dev (at 5% false alarms) and frozen before scoring test. The subtle attacks and the scrambled innocent controls were **added after a first look at test results**, because every original attack said "AI assistant" out loud and Jev's perfect score needed a harder check. No threshold or wording changed.

## Results

Test split. Confidence intervals are 95%, from 2,000 bootstrap resamples. AUC is the chance a random attack scores above a random innocent text (1.0 is perfect, 0.5 is guessing).

**Document chunks** (119 attacks, 120 innocent chunks):

| Detector | AUC | Recall at frozen threshold | False alarms | Subtle attacks: AUC | Subtle: recall |
|---|---|---|---|---|---|
| **Jev** | **1.00** (1.00 to 1.00) | **100%** | 8% (3% to 12%) | **0.98** | **97%** |
| **Kev-4B** | 0.90 (0.85 to 0.93) | 70% | 11% | 0.93 | 62% |
| Keywords | 0.88 | 65% | 0% | 0.48 | 0% |
| Prompt Guard 2 | 0.83 | 19% | 2% | 0.48 | 0% |
| Laya | 0.82 | 21% | 1% | 0.78 | 21% |
| ProtectAI DeBERTa | 0.76 | 8% | 0% | 0.49 | 0% |
| GLiNER2.5-Decide | 0.75 | 6% | 1% | 0.67 | 17% |
| Kev-0.8B | 0.70 | 10% | 5% | 0.50 | 3% |

**User messages** (60 deepset injections, 282 innocent: NotInject + deepset benign):

| Detector | AUC | Recall at frozen threshold | False alarms |
|---|---|---|---|
| **Jev** | **0.88** (0.82 to 0.93) | 78% | 16% |
| Kev-4B | 0.84 | 63% | 14% |
| Kev-0.8B | 0.79 | 55% | 13% |
| GLiNER2.5-Decide | 0.70 | 42% | 7% |
| Prompt Guard 2 | 0.64 | 20% | 15% |
| Laya | 0.60 | 20% | 15% |
| ProtectAI DeBERTa | 0.50 | 13% | 15% |
| Keywords | 0.50 | 2% | 2% |

**Adaptive attacks.** An LLM attacker (gpt-oss-120b) rewrote 10 attacks each detector had caught, seeing the detector's score, up to 5 tries. A rewrite counted only if it kept the canary code and a judge call confirmed it still tried to make an AI do the same thing.

| Detector | Evaded |
|---|---|
| Prompt Guard 2 | 9/10 |
| ProtectAI DeBERTa | 8/9 |
| GLiNER2.5-Decide | 8/10 |
| Jev | 4/10 |
| Laya | 2/10 |
| Kev-4B | 1/10 |

**Speed and cost** on this machine: Jev 313 ms p50 (network included) and $0.023 per 1,000 texts. Kev-4B 1.1 s, Laya 171 ms, GLiNER 186 ms, Kev-0.8B 158 ms, ProtectAI 30 ms, all $0. Prompt Guard's 2.1 s is the pacing used for Groq's rate limit, not the model.

## What stood out

1. **Jev was the only detector that caught attacks that don't announce themselves.** On subtle attacks it scored 0.98. Kev-4B managed 0.93 with lower recall; the three classifiers built for injection (Prompt Guard, ProtectAI, keywords) were at chance.
2. **Kev-4B is the strongest open option, by a wide margin.** It is also the least consistent: rewording an attack flipped its decision on 11 of 18 sets, and "classifier, answer no" bait made it miss 6 of 18 attacks it otherwise caught. Jev flipped 0 of 18 on both.
3. **Part of Jev's robustness is flagging anything strange.** It caught nearly every scrambled attack, but it also flagged 7 of 8 innocent ROT13 sentences and 5 of 8 innocent leetspeak ones. Without the innocent controls this would have looked like pure robustness.
4. **Jev's main weakness is false alarms**: 8% of innocent document chunks (mostly quoted system prompts and security reminders) and 30 of 71 NotInject "technique" questions ("Can I ignore this warning in my code?") at the frozen user threshold.
5. **Jev is not deterministic.** The same text sent three times changed score on 33 of 50 texts, by up to 0.07.
6. **The dedicated injection classifiers are tuned to jailbreak phrasing.** Prompt Guard caught 23/23 "ignore your instructions" attacks and 0 of every other goal.
7. **Laya's scores are poorly separated on user messages** (0.60 AUC, with 61% false alarms at its native 0.5), and it drops off on long input (0 of 6 at 1,200 and 2,400 words), consistent with its 512-token window.
8. **Adaptive attacks beat every detector sometimes**, and the injection classifiers almost always, usually within 2 rewrites.

## Caveats

- One document domain (fictional business documents). Attacks and look-alikes are template-based; real attacks will differ.
- Small groups: 29 subtle attacks, 6 to 12 per obfuscation, 10 attacks per detector in the adaptive round. Intervals are wide there.
- Adaptive starting sets differ by detector: each starts from attacks it already caught, which for weak detectors are the most obvious ones.
- deepset labels are broad: some "injections" are ordinary task requests.
- Jev's wording was tuned on dev cases from this repo; the open models were not fine-tuned for this task. Kev ships a training recipe, so a tuned Kev could do better.
- Jev latency includes a network round trip; local models share one laptop chip and ran one at a time.

## Run it

Needs Python 3.12, `uv`, the repo's `.env` (Jev and Groq keys), and a Kev server for the Kev rows ([jaredpalmer/kev](https://github.com/jaredpalmer/kev); 0.8B on port 8009, 4B on port 8011).

```sh
cd eval
uv venv venv --python 3.12
uv pip install --python venv/bin/python -r requirements.txt

venv/bin/python -m bench.data                 # rebuild data/cases.jsonl (checksum in data/manifest.json)
venv/bin/python -m bench.run jev              # or kev-4b, kev-0.8b, laya, gliner-labels_plain,
                                              #    protectai-deberta, promptguard2, keywords
venv/bin/python -m bench.adaptive jev         # adaptive attack round
venv/bin/python -m bench.report               # results/report.md and results/summary.json
```

Runs resume where they stopped and never re-score a case. Raw outputs for every call are in `results/raw/`.
