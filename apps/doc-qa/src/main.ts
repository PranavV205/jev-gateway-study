import "./style.css";
import { docs, questionsFor, type SampleQuestion } from "./corpus";
import { type Chunk, chunkDocument, retrieve } from "./retrieve";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:8000";
const TOP_K = 5;

interface GatewayReport {
  request_id: string;
  action: string;
  dropped_chunks: string[];
  tier: string | null;
  model: string | null;
  cost_usd: number;
  baseline_cost_usd: number;
  latency_ms: { total: number; model: number };
  error?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const docSelect = $<HTMLSelectElement>("doc");
const docText = $<HTMLPreElement>("doc-text");
const form = $<HTMLFormElement>("ask");
const questionInput = $<HTMLTextAreaElement>("question");
const samples = $<HTMLDivElement>("samples");
const tierSelect = $<HTMLSelectElement>("tier");
const submit = form.querySelector("button") as HTMLButtonElement;
const result = $<HTMLDivElement>("result");
const answerEl = $<HTMLParagraphElement>("answer");
const expectedEl = $<HTMLParagraphElement>("expected");
const reportEl = $<HTMLDListElement>("report");
const chunkCount = $<HTMLSpanElement>("chunk-count");
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

function row(label: string, value: string) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  return [dt, dd];
}

const usd = (n: number) => `$${n.toFixed(6)}`;

// gpt-oss often uses narrow no-break spaces and non-breaking hyphens, which some fonts
// render with no visible gap, and sometimes adds Markdown bold despite the prompt.
// Answers are shown as plain text, so normalize those before display.
const plain = (s: string) =>
  s
    .replace(/[\u00a0\u202f\u2007]/g, " ")
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/\*\*(.+?)\*\*/g, "$1");

function render(answer: string | null, report: GatewayReport, sent: Chunk[]) {
  answerEl.textContent = answer ? plain(answer) : "(no answer)";
  const expected = activeSample?.question === questionInput.value.trim() ? activeSample : null;
  expectedEl.hidden = !expected;
  if (expected) expectedEl.textContent = `Reference answer: ${expected.answer}`;

  reportEl.replaceChildren(
    ...row("Action", report.action),
    ...row("Model", `${report.model ?? "none"} (${report.tier ?? "no"} tier)`),
    ...row("Cost", `${usd(report.cost_usd)} (all-strong baseline ${usd(report.baseline_cost_usd)})`),
    ...row("Latency", `${report.latency_ms.total} ms total, ${report.latency_ms.model} ms in the model`),
    ...row("Dropped chunks", report.dropped_chunks.length ? report.dropped_chunks.join(", ") : "none"),
    ...row("Request ID", report.request_id),
    ...(report.error ? row("Error", report.error) : []),
  );

  chunkCount.textContent = String(sent.length);
  chunksEl.replaceChildren(
    ...sent.map((c) => {
      const li = document.createElement("li");
      const pre = document.createElement("pre");
      pre.textContent = c.text;
      li.append(c.id, pre);
      return li;
    }),
  );
  result.hidden = false;
}

async function ask(event: SubmitEvent) {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  const sent = retrieve(question, chunks, TOP_K);
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
    if (!body.gateway) throw new Error(`Gateway returned ${res.status}: ${JSON.stringify(body)}`);
    render(body.answer, body.gateway, sent);
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
