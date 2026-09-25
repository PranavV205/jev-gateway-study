# jev-gateway-study

A small gateway that sits between an LLM app and its model providers, used to test [Jev](https://docs.typesafe.ai/introduction), a decision model from TypeSafe, as a prompt-injection screen and a model router.

**Live demo:** [doc-qa](https://jev-gateway-doc-qa.work-pranavv.workers.dev) · [dashboard](https://jev-gateway-dashboard.work-pranavv.workers.dev) · [gateway health](https://jev-gateway-study.work-pranavv.workers.dev/healthz)

Work in progress. So far:

- `eval/`: a frozen, head-to-head benchmark of Jev and the open decision models (Kev, Laya, GLiNER2.5-Decide) plus Prompt Guard 2, ProtectAI, and a keyword filter, on in-document attacks, user jailbreaks, obfuscation, false alarms, and adaptive attacks. Results in [`eval/README.md`](eval/README.md).
- `experiments/`: early tests of Jev as an injection screen. See the READMEs in [`smoke`](experiments/smoke), [`hard-cases`](experiments/hard-cases), and [`question-wording`](experiments/question-wording).
- `corpus/`: fictional business documents and questions for the demo app.
- `gateway/`: a Cloudflare Worker (Hono, D1) with `POST /v1/chat`. It screens the user message and every chunk with Jev in parallel, refuses a prompt-injection attempt in the user message, drops chunks that look like planted instructions, and asks Jev what kind of task the question is. Clear lookups and extractions go to the cheap model, everything else to the strong one. Every screening and routing decision is logged. If Groq fails it retries with backoff, then falls back to a list of free OpenRouter models, and if the cheap tier fails entirely it escalates to the strong tier. Jev calls go through a rate limiter and a circuit breaker.
- `apps/dashboard/`: a one-page dashboard over the gateway's logs: cost with the gateway vs. always using the strong model, routing by task type, threats caught, Jev score distributions, latency, retries and fallbacks, and recent borderline cases. It reads `GET /v1/stats`.
- `apps/doc-qa/`: a small demo page. Pick a document from the corpus, ask a question, and see the answer plus the gateway's report, including each chunk's screening scores. It can plant a harmless test attack in a chunk so you can watch the gateway drop it.

## Run locally

Needs Node 22+.

```sh
npm install
cp gateway/.dev.vars.example gateway/.dev.vars   # then add your keys
npm run dev
```

This starts the gateway at http://localhost:8000, doc-qa at http://localhost:5173, and the dashboard at http://localhost:5174.

To fill the dashboard, send the corpus questions through the gateway (some with planted test attacks, plus a few attack questions):

```sh
npm run demo:traffic
```

To call the gateway directly:

```sh
curl -X POST localhost:8000/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"app_id": "demo", "user_message": "What is the total due?", "context_chunks": [{"id": "c1", "text": "Total due: $12,214.80"}]}'
```

The response has the answer plus a `gateway` block with the screening scores, dropped chunks, routing decision, model used, cost, and latency. `GET /v1/requests/:id` returns the logged record, including one row per screened text. Set `"options": {"classifier": "none"}` to skip screening, `"router": "none"` to always use the strong model, or `"force_tier": "cheap"` to pick a tier.

## Deploy

Everything runs on Cloudflare: the gateway is a Worker with a D1 database, and doc-qa and the dashboard are Workers that serve static files.

```sh
cd gateway
npx wrangler login
npx wrangler d1 create jev-gateway-study          # put the returned id in wrangler.toml
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
npx wrangler secret put TYPESAFE_API_KEY          # and GROQ_API_KEY, OPENROUTER_API_KEY

cd ../apps/doc-qa    && VITE_GATEWAY_URL=<gateway url> npm run deploy
cd ../dashboard      && VITE_GATEWAY_URL=<gateway url> npm run deploy
```

Then set `ALLOWED_ORIGINS` in `gateway/wrangler.toml` to the two page URLs and deploy the gateway again.

## Public demo limits

The gateway spends free-tier API quotas, so `POST /v1/chat` is protected when deployed:

- 10 requests a minute per visitor IP (a Cloudflare rate limiting binding; counted per data center, so it is approximate)
- `DAILY_REQUEST_CAP` chat requests a day across everyone (default 300)
- Browsers may only call the API from origins listed in `ALLOWED_ORIGINS`

All three are set in `gateway/wrangler.toml`.

## Checks

```sh
npm run lint
npm run typecheck
npm test                 # gateway tests run inside the Workers runtime with a local D1
RUN_LIVE=1 npm test      # also calls the real Jev and OpenRouter APIs (needs keys in the environment)
```

## Stack

TypeScript on Cloudflare Workers, [Hono](https://hono.dev), [Zod](https://zod.dev), [Drizzle](https://orm.drizzle.team) with D1, Vitest, Biome. doc-qa is plain TypeScript built with Vite. LLM calls go to Groq (`openai/gpt-oss-20b` and `openai/gpt-oss-120b`), with free OpenRouter models as the fallback. Model names, prices, Jev questions, and thresholds live in [`config/default.json`](config/default.json).
