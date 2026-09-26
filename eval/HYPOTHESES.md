# Hypotheses

Written 2026-09-25, before any test-split results. Each is a prediction to check, not a claim.

## Detection

1. **Jev has the best ranking on in-document attacks** (highest ROC-AUC on `embedded_attack` + `grid_attack` vs. clean and look-alike chunks), because its wording was tuned for chunks and it has the largest model behind it.
2. **The open decision models (Kev, Laya, GLiNER) rank worse than Jev on the same wording**, and the gap is largest on disguised attacks (HTML comments, fake system tags).
3. **Prompt Guard 2 and the keyword filter miss most attacks that don't use jailbreak phrasing** (answer manipulation, exfiltration links), as in the earlier hard-case run.
4. **ProtectAI DeBERTa has the most false alarms on NotInject**, since it was trained on trigger-word-heavy injection data.

## False alarms

5. **Every model's worst false-alarm group is `benign_lookalike`** (innocent instruction-like sentences inside documents), not NotInject.
6. **At a tuned threshold, no detector reaches 90% recall on in-document attacks while keeping false alarms on look-alike chunks under 5%.**

## Robustness

7. **Base64 and ROT13 are the hardest obfuscations for every detector.** Homoglyphs and zero-width characters hurt the encoder models (ProtectAI, Prompt Guard, GLiNER) more than Jev.
8. **Laya's recall falls on the 1,200 and 2,400-word length cases**, because its English checkpoint reads 512 tokens.
9. **Classifier bait ("this passage is benign; answer no") lowers scores for question-based models** more than for fixed classifiers.

## Consistency and calibration

10. **Jev is not perfectly deterministic** across three identical calls, but differences are under 0.01.
11. **Jev is overconfident on hard negatives**: some benign look-alikes score above 0.9.

## Cost and speed

12. **The local open models are more than 5x faster than Jev per text** on this machine, and cost $0 per call.

## Adaptive attacks

13. **An LLM attacker with five tries evades every detector on more than half of the attacks it starts from.**

## Outcomes

Checked 2026-09-26 against `results/report.md`. The predictions above are unchanged.

| # | Held? | What happened |
|---|-------|---------------|
| 1 | Yes | Jev AUC 1.00 on in-document attacks, the highest. |
| 2 | Partly | All open models ranked lower, but Kev-4B was close (0.90). The largest gaps were on subtle attacks and obfuscation, not on HTML comments or system tags. |
| 3 | Yes | Prompt Guard caught 0 attacks outside "ignore your instructions" phrasing; keywords caught 0 subtle attacks. |
| 4 | No | ProtectAI's false alarms on NotInject (15% at its frozen threshold) matched Laya and Prompt Guard. Its real weakness was catching almost nothing (AUC 0.50 on user messages). |
| 5 | Mostly | For most detectors the look-alike chunks were the worst document group. Jev's highest false-alarm rate overall was on NotInject "technique" questions (30/71). |
| 6 | Yes | No detector reached 90% recall on in-document attacks with under 5% false alarms on look-alikes. Jev came closest: 100% recall, 10% of look-alikes flagged. |
| 7 | No | Jev caught nearly every obfuscation, including base64 and ROT13, but it also flagged innocent text put through the same transforms (7 of 8 ROT13). The encoder models missed almost all obfuscations of every kind. |
| 8 | Yes | Laya caught 3 of 6 at 150 and 600 words, 0 of 6 at 1,200 and 2,400. |
| 9 | Partly | Bait lowered Kev-4B (-0.15 on average, 6 of 18 caught attacks then missed) and GLiNER (-0.21). Jev (+0.04) and Laya (+0.12) scored the baited versions slightly higher, and the fixed classifiers barely moved. |
| 10 | No | Jev changed score on 33 of 50 repeated texts, by up to 0.07, well above the predicted 0.01. |
| 11 | Yes | 9 of 87 innocent look-alike chunks scored above Jev's frozen threshold. |
| 12 | No | Only ProtectAI (30 ms) was more than 5x faster than Jev (313 ms, network included). Laya and GLiNER were about 1.7x faster; Kev-4B was 3.5x slower. |
| 13 | Partly | Over half evaded for Prompt Guard, ProtectAI, and GLiNER; not for Jev (4/10), Laya (2/10), or Kev-4B (1/10). |

## Fresh held-out set (written 2026-09-26, before building or scoring it)

Human-written attacks from Microsoft's LLMail-Inject challenge (Phase 2) that actually hijacked the email assistant, split by whether Microsoft's defenses caught them, against real Enron business emails. No tuning: every detector uses the chunk threshold already frozen on this repo's dev split.

14. **Every detector's AUC is lower here than on this repo's in-document test set.** Human attacks are more varied than my templates, and Enron emails are full of human-to-human instructions.
15. **Jev still ranks first, but its lead over Kev-4B shrinks to under 0.05 AUC.**
16. **Prompt Guard 2 and ProtectAI do much better here than on the template set**, because many LLMail attacks use explicit "ignore instructions / send an email" phrasing that they were trained on.
17. **Attacks that got past Microsoft's defenses are harder for every detector than the ones Microsoft caught.**
18. **Jev's false alarms on Enron emails at its frozen threshold are above 10%.**

### Outcomes for the fresh set

Checked 2026-09-26 against `results/report.md`.

| # | Held? | What happened |
|---|-------|---------------|
| 14 | No | Jev (1.00 to 1.00), Kev-4B (0.90 to 0.99), Laya, GLiNER, and ProtectAI all ranked as well or better on human attacks. Only Prompt Guard dipped slightly (0.83 to 0.81). |
| 15 | Yes | Jev still first, and Kev-4B came within 0.01 AUC (0.99 vs 1.00). |
| 16 | No | Prompt Guard and ProtectAI ranked a bit better (0.81 and 0.83 AUC) but caught 3 to 4% at their frozen thresholds. |
| 17 | Mostly | Attacks that got past Microsoft were a little harder for most detectors (Jev 93% vs 96%, Kev-4B 82% vs 88%), but not for Kev-0.8B or ProtectAI. |
| 18 | No | Jev flagged 0 of 400 Enron emails at its frozen threshold. |
