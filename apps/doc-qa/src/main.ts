import "./style.css";
import { ATTACKS, isAttackId } from "./attacks";
import { docs, questionsFor, type SampleQuestion } from "./corpus";
import { type Chunk, chunkDocument, retrieve } from "./retrieve";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:8000";
const TOP_K = 5;

interface ChunkScreen {
  id: string;
  p_injection: number | null;
  p_exfil: number | null;
  action: "kept" | "dropped";
  reason: string | null;
}

interface GatewayReport {
  request_id: string;
  action: "allowed" | "refused" | "error";
  dropped_chunks: string[];
  tier: string | null;
  provider: string | null;
  model: string | null;
  route: {
    router: string;
    task_type: string | null;
    confidence: number | null;
    p_needs_strong: number | null;
    tier: string;
    reason: string;
  };
  screen: {
    classifier: string;
    flagged: boolean;
    user: { p_injection: number | null; reason: string | null };
    chunks: ChunkScreen[];
  } | null;
  cost_usd: number;
  baseline_cost_usd: number;
  latency_ms: { screen: number; route: number; model: number; total: number };
  llm_attempts: { kind: string; tier: string; provider: string; model: string; ok: boolean; latency_ms: number }[];
  error?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const docSelect = $<HTMLSelectElement>("doc");
const docText = $<HTMLPreElement>("doc-text");
const form = $<HTMLFormElement>("ask");
const questionInput = $<HTMLTextAreaElement>("question");
const samples = $<HTMLDivElement>("samples");
const attackSelect = $<HTMLSelectElement>("attack");
const tierSelect = $<HTMLSelectElement>("tier");
const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
const result = $<HTMLDivElement>("result");
const answerEl = $<HTMLParagraphElement>("answer");
const expectedEl = $<HTMLParagraphElement>("expected");
const reportEl = $<HTMLDListElement>("report");
const screenSummary = $<HTMLParagraphElement>("screen-summary");
const chunksEl = $<HTMLOListElement>("chunks");
const errorEl = $<HTMLParagraphElement>("error");

let chunks: Chunk[] = [];
let activeSample: SampleQuestion | null = null;

for (const d of docs) docSelect.add(new Option(d.title, d.id));

function selectDoc(id: string) {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  docText.textContent = doc.markdown;
  chunks = chunkDocument(doc.id, doc.markdown);

  samples.replaceChildren(
    ...questionsFor(doc.id).map((q) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = q.question;
      b.title = q.task_type;
      b.addEventListener("click", () => {
        questionInput.value = q.question;
        activeSample = q;
      });
      return b;
    }),
  );
  activeSample = null;
  result.hidden = true;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function row(label: string, value: string) {
  return [el("dt", label), el("dd", value)];
}

const usd = (n: number) => `$${n.toFixed(6)}`;
const score = (p: number | null) => (p === null ? "not screened" : p.toFixed(2));

const ROUTE_REASONS: Record<string, string> = {
  cheap_task: "simple task, confident",
  strong_task: "not clearly a simple lookup or extraction",
  needs_strong: "router says it needs careful reasoning",
  route_failed: "router failed, defaulting to strong",
  no_router: "routing off",
  forced: "forced",
};

function describeRoute(r: GatewayReport["route"]) {
  const why = ROUTE_REASONS[r.reason] ?? r.reason;
  if (!r.task_type || r.confidence === null) return `${r.tier} tier (${why})`;
  return `${r.task_type} (confidence ${r.confidence.toFixed(2)}, needs strong ${score(r.p_needs_strong)}) → ${r.tier} tier, ${why}`;
}

// gpt-oss often uses narrow no-break spaces and non-breaking hyphens, which some fonts
// render with no visible gap, and sometimes adds Markdown bold despite the prompt.
// Answers are shown as plain text, so normalize those before display.
const plain = (s: string) =>
  s
    .replace(/[\u00a0\u202f\u2007]/g, " ")
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/\*\*(.+?)\*\*/g, "$1");

// Appends the chosen test attack to the first chunk, so it always reaches the gateway.
function withAttack(sent: Chunk[], attackId: string): { chunks: Chunk[]; plantedIn: string | null } {
  const first = sent[0];
  if (!first || !isAttackId(attackId)) return { chunks: sent, plantedIn: null };
  return {
    chunks: [{ ...first, text: `${first.text}\n\n${ATTACKS[attackId]}` }, ...sent.slice(1)],
    plantedIn: first.id,
  };
}

function renderScreen(report: GatewayReport, sent: Chunk[], plantedIn: string | null) {
  const s = report.screen;
  if (!s) {
    screenSummary.textContent = "Screening was skipped.";
  } else if (report.action === "refused") {
    screenSummary.textContent = `Refused: the question scored ${score(s.user.p_injection)} as a prompt-injection attempt.`;
  } else {
    const dropped = s.chunks.filter((c) => c.action === "dropped").length;
    screenSummary.textContent =
      `Question scored ${score(s.user.p_injection)}${s.flagged ? " (could not be screened, allowed and flagged)" : ""}. ` +
      `${s.chunks.length - dropped} of ${s.chunks.length} chunks kept, ${dropped} dropped.`;
  }

  const byId = new Map(s?.chunks.map((c) => [c.id, c]));
  chunksEl.replaceChildren(
    ...sent.map((c) => {
      const verdict = byId.get(c.id);
      const li = el("li", undefined, verdict?.action === "dropped" ? "dropped" : "");
      const head = el("div", undefined, "chunk-head");
      head.append(el("strong", c.id));
      if (verdict) {
        head.append(
          el("span", verdict.action === "dropped" ? `dropped (${verdict.reason})` : "kept", `badge ${verdict.action}`),
          el("span", `injection ${score(verdict.p_injection)}, exfiltration ${score(verdict.p_exfil)}`, "scores"),
        );
      }
      if (c.id === plantedIn) head.append(el("span", "test attack planted here", "badge planted"));
      li.append(head, el("pre", c.text));
      return li;
    }),
  );
}

function render(answer: string | null, report: GatewayReport, sent: Chunk[], plantedIn: string | null) {
  answerEl.textContent =
    report.action === "refused"
      ? "The gateway refused this question, so no model was called."
      : answer
        ? plain(answer)
        : "(no answer)";
  const expected = activeSample?.question === questionInput.value.trim() ? activeSample : null;
  expectedEl.hidden = !expected;
  if (expected) expectedEl.textContent = `Reference answer: ${expected.answer}`;

  reportEl.replaceChildren(
    ...row("Action", report.action),
    ...row("Route", describeRoute(report.route)),
    ...row("Model", report.model ? `${report.model} via ${report.provider}` : "none called"),
    ...(report.llm_attempts.length > 1
      ? row(
          "Attempts",
          report.llm_attempts
            .map((a) => `${a.kind} ${a.provider} ${a.tier} ${a.ok ? "ok" : "failed"} (${a.latency_ms} ms)`)
            .join(" → "),
        )
      : []),
    ...row("Cost", `${usd(report.cost_usd)} (all-strong baseline ${usd(report.baseline_cost_usd)})`),
    ...row(
      "Latency",
      `${report.latency_ms.total} ms total: ${report.latency_ms.screen} ms screening and ${report.latency_ms.route} ms routing (in parallel), ${report.latency_ms.model} ms model`,
    ),
    ...row("Request ID", report.request_id),
    ...(report.error ? row("Error", report.error) : []),
  );

  renderScreen(report, sent, plantedIn);
  result.hidden = false;
}

async function ask(event: SubmitEvent) {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  const { chunks: sent, plantedIn } = withAttack(retrieve(question, chunks, TOP_K), attackSelect.value);
  errorEl.hidden = true;
  submit.disabled = true;
  submit.textContent = "Asking...";

  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: "doc-qa",
        user_message: question,
        context_chunks: sent,
        options: { force_tier: tierSelect.value || null },
      }),
    });
    const body = await res.json();
    if (res.status === 429 && body.message) {
      errorEl.textContent = body.message;
      errorEl.hidden = false;
      return;
    }
    if (!body.gateway) throw new Error(`Gateway returned ${res.status}: ${JSON.stringify(body)}`);
    render(body.answer, body.gateway, sent, plantedIn);
  } catch (err) {
    errorEl.textContent = `Request failed: ${err instanceof Error ? err.message : String(err)}. Is the gateway running at ${GATEWAY_URL}?`;
    errorEl.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = "Ask";
  }
}

docSelect.addEventListener("change", () => selectDoc(docSelect.value));
form.addEventListener("submit", ask);
selectDoc(docSelect.value);
