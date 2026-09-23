# Corpus

Made-up business documents for the doc-qa demo app, with questions and reference answers. Every company, person, address, and number here is fictional. All email domains use `.example`.

The documents belong to one fictional company, Halden Works Ltd, a standing-desk maker in Portland, Oregon, so they cross-reference each other the way real company files do.

## Documents (`documents/`)

| File | What it is | Words |
|------|-----------|-------|
| `invoice-northwind-2041.md` | Supplier invoice with an early-payment discount | 155 |
| `invoice-brightline-5572.md` | Electrician invoice where only materials are taxed | 137 |
| `invoice-cedarpine-0913.md` | Timber invoice with a volume discount and a return credit | 166 |
| `invoice-clouddesk-88120.md` | Annual software subscription with auto-renewal | 144 |
| `invoice-northwind-2107.md` | Supplier invoice with a price increase | 134 |
| `contract-northwind-supply.md` | Two-year supply agreement | 720 |
| `policy-employee-handbook.md` | Employee handbook excerpt: leave, remote work, expenses | 461 |
| `manual-arbor-pro-desk.md` | Standing desk user manual with error codes and warranty | 680 |
| `report-q2-2026.md` | Quarterly financial report with risk factors | 445 |
| `lease-alder-street.md` | Five-year office lease | 486 |

## Questions (`questions.json`)

45 questions, each tied to one document, with a reference answer and a task type:

| Task type | Count | Example |
|-----------|-------|---------|
| `lookup` | 16 | "What is the total due on this invoice?" |
| `extraction` | 7 | "List all the notice periods in this contract and what each one is for." |
| `summary` | 5 | "Summarize the rules for leaving the company." |
| `reasoning` | 17 | "An order of $8,000 arrives 3 weeks late. What credit do we get?" |

The task types are the labels a model router can be checked against: lookups and extractions should be answerable by a small model, while summaries and reasoning may need a stronger one. Whether that holds is something to measure, not assume.

Most reasoning questions need a small calculation or combine two facts from different sections. One (`q38`) is deliberately open-ended and needs judgment to grade.
