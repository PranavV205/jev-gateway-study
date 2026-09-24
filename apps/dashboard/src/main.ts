import "./style.css";
import { histogram, horizontalBars, stackedColumns } from "./charts";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:8000";

interface Summary {
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

interface Stats {
  range: string;
  bucket: "hour" | "day";
  from: string | null;
  to: string | null;
  note: string;
  apps: string[];
  totals: { requests: number; allowed: number; refused: number; errors: number; flagged: number };
  cost: {
    total_usd: number;
    answered: {
      requests: number;
      gateway_usd: number;
      llm_usd: number;
      screen_usd: number;
      route_usd: number;
      baseline_usd: number;
    };
    series: { bucket: string; requests: number; llm: number; screen: number; route: number; baseline: number }[];
  };
  routing: {
    routed: number;
    cheap: number;
    cheap_share: number | null;
    by_task: { task_type: string; cheap: number; strong: number }[];
  };
  threats: {
    questions_screened: number;
    questions_refused: number;
    chunks_screened: number;
    chunks_dropped: number;
    drop_reasons: Record<string, number>;
    screen_errors: number;
  };
  scores: {
    thresholds: { userInjection: number; chunkInjection: number; exfiltration: number };
    chunk_injection: number[];
    user_injection: number[];
  };
  latency: { total: Summary; screen: Summary; route: Summary; model: Summary };
  reliability: { attempts: Record<string, number>; answered_by_fallback: number; answered_by_escalation: number };
  recent: { request_id: string; created_at: string; kind: string; detail: string }[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const rangeSelect = $<HTMLSelectElement>("range");
const appSelect = $<HTMLSelectElement>("app");
const refresh = $<HTMLButtonElement>("refresh");
const main = $<HTMLElement>("main");
const content = $<HTMLElement>("content");
const errorEl = $<HTMLParagraphElement>("error");
const emptyEl = $<HTMLParagraphElement>("empty");

const SERIES = { a: "var(--series-1)", b: "var(--series-2)", c: "var(--series-3)", ref: "var(--text-secondary)" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// Costs here are tiny, so show enough digits to tell requests apart.
function usd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(6)}`;
  if (v < 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function usdAxis(v: number): string {
  if (v === 0) return "$0";
  return `$${Number(v.toPrecision(2))}`;
}

const pct = (v: number | null) => (v === null ? "none" : `${Math.round(v * 100)}%`);
const ms = (v: number | null) => (v === null ? "none" : `${Math.round(v).toLocaleString()} ms`);

function bucketLabel(bucket: string, unit: "hour" | "day"): string {
  const d = new Date(unit === "hour" ? bucket.replace("Z", ":00Z") : `${bucket}T00:00:00Z`);
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return unit === "hour" ? `${day} ${String(d.getHours()).padStart(2, "0")}:00` : day;
}

function renderHero(s: Stats) {
  const a = s.cost.answered;
  const value = $<HTMLParagraphElement>("hero-value");
  const detail = $<HTMLParagraphElement>("hero-detail");
  if (!a.requests || !a.baseline_usd) {
    value.textContent = "No answered requests yet";
    detail.textContent = "";
    return;
  }
  const change = (a.gateway_usd - a.baseline_usd) / a.baseline_usd;
  const word = change >= 0 ? "more" : "less";
  value.textContent = `${change >= 0 ? "+" : "−"}${Math.abs(Math.round(change * 100))}% ${word}`;
  detail.textContent =
    `${usd(a.gateway_usd)} with the gateway vs. ${usd(a.baseline_usd)} on the strong model alone, across ${a.requests} answered requests. ` +
    `Gateway cost = model calls ${usd(a.llm_usd)} + Jev screening ${usd(a.screen_usd)} + Jev routing ${usd(a.route_usd)}.`;
}

function tile(label: string, value: string, sub: string) {
  const t = el("div", undefined, "tile card");
  t.append(el("p", label, "label"), el("p", value, "tile-value"), el("p", sub, "detail"));
  return t;
}

function renderTiles(s: Stats) {
  const r = s.reliability;
  $<HTMLDivElement>("tiles").replaceChildren(
    tile(
      "Requests",
      s.totals.requests.toLocaleString(),
      `${s.totals.allowed} allowed, ${s.totals.refused} refused, ${s.totals.errors} errors`,
    ),
    tile(
      "Questions refused",
      s.threats.questions_refused.toLocaleString(),
      `of ${s.threats.questions_screened} screened${s.totals.flagged ? `, ${s.totals.flagged} let through unscreened` : ""}`,
    ),
    tile("Chunks dropped", s.threats.chunks_dropped.toLocaleString(), `of ${s.threats.chunks_screened} screened`),
    tile("Sent to the cheap model", pct(s.routing.cheap_share), `${s.routing.cheap} of ${s.routing.routed} routed`),
    tile(
      "Answered by a backup",
      (r.answered_by_fallback + r.answered_by_escalation).toLocaleString(),
      `${r.answered_by_fallback} by OpenRouter, ${r.answered_by_escalation} escalated to strong`,
    ),
    tile("Latency, p95", ms(s.latency.total.p95), `p50 ${ms(s.latency.total.p50)}`),
  );
}

function renderCharts(s: Stats) {
  const series = s.cost.series;
  stackedColumns($("chart-cost"), {
    categories: series.map((b) => bucketLabel(b.bucket, s.bucket)),
    labels: series.map((b) => bucketLabel(b.bucket, s.bucket)),
    series: [
      { name: "Model calls", color: SERIES.a, values: series.map((b) => b.llm) },
      { name: "Jev screening", color: SERIES.b, values: series.map((b) => b.screen) },
      { name: "Jev routing", color: SERIES.c, values: series.map((b) => b.route) },
    ],
    line: { name: "Strong model only", color: SERIES.ref, values: series.map((b) => b.baseline) },
    format: usd,
    axisFormat: usdAxis,
  });

  horizontalBars($("chart-routing"), {
    rows: s.routing.by_task.map((t) => ({ label: t.task_type, values: [t.cheap, t.strong] })),
    series: [
      { name: "Cheap model", color: SERIES.a },
      { name: "Strong model", color: SERIES.b },
    ],
    format: (v) => String(v),
  });

  const d = s.threats.drop_reasons;
  horizontalBars($("chart-threats"), {
    rows: [
      { label: "Questions refused", values: [s.threats.questions_refused] },
      { label: "Chunks: injection", values: [d.injection ?? 0] },
      { label: "Chunks: exfiltration", values: [d.exfiltration ?? 0] },
      { label: "Chunks: not screened", values: [d.screen_failed ?? 0] },
    ],
    series: [{ name: "Count", color: SERIES.a }],
    format: (v) => String(v),
  });

  const th = s.scores.thresholds;
  histogram($("chart-chunk-scores"), {
    bins: s.scores.chunk_injection,
    threshold: th.chunkInjection,
    thresholdLabel: `drop at ${th.chunkInjection}`,
    color: SERIES.a,
    unit: "chunks",
  });
  histogram($("chart-user-scores"), {
    bins: s.scores.user_injection,
    threshold: th.userInjection,
    thresholdLabel: `refuse at ${th.userInjection}`,
    color: SERIES.a,
    unit: "questions",
  });
}

function fillTable(table: HTMLTableElement, headers: string[], rows: string[][], numeric: number[] = []) {
  const thead = el("thead");
  const tr = el("tr");
  tr.append(...headers.map((h, i) => el("th", h, numeric.includes(i) ? "num" : undefined)));
  thead.append(tr);
  const tbody = el("tbody");
  for (const r of rows) {
    const row = el("tr");
    row.append(...r.map((c, i) => el("td", c, numeric.includes(i) ? "num" : undefined)));
    tbody.append(row);
  }
  table.replaceChildren(thead, tbody);
}

function renderTables(s: Stats) {
  const l = s.latency;
  fillTable(
    $<HTMLTableElement>("latency"),
    ["Stage", "p50", "p95", "p99", "n"],
    (
      [
        ["Screening", l.screen],
        ["Routing", l.route],
        ["Model call", l.model],
        ["Total", l.total],
      ] as const
    ).map(([name, x]) => [name, ms(x.p50), ms(x.p95), ms(x.p99), String(x.n)]),
    [1, 2, 3, 4],
  );

  const a = s.reliability.attempts;
  fillTable(
    $<HTMLTableElement>("attempts"),
    ["Kind", "Calls"],
    [
      ["First try", String(a.primary ?? 0)],
      ["Retry on Groq", String(a.retry ?? 0)],
      ["OpenRouter fallback", String(a.fallback ?? 0)],
      ["Escalated to strong", String(a.escalation ?? 0)],
    ],
    [1],
  );

  const recent = $<HTMLTableElement>("recent");
  if (!s.recent.length) {
    fillTable(recent, ["Nothing borderline in this range"], []);
    return;
  }
  fillTable(
    recent,
    ["When", "What", "Detail", "Request"],
    s.recent.map((r) => [
      new Date(r.created_at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      r.kind,
      r.detail,
      r.request_id.slice(0, 8),
    ]),
  );
}

let last: Stats | null = null;

function render(s: Stats) {
  last = s;
  const empty = s.totals.requests === 0;
  emptyEl.hidden = !empty;
  content.hidden = empty;
  if (empty) return;
  renderHero(s);
  renderTiles(s);
  renderCharts(s);
  renderTables(s);
  $<HTMLParagraphElement>("note").textContent = s.note;
}

function syncApps(apps: string[]) {
  const current = appSelect.value;
  appSelect.replaceChildren(new Option("All apps", ""), ...apps.map((a) => new Option(a, a)));
  appSelect.value = apps.includes(current) ? current : "";
}

async function load() {
  // Keep the previous render on screen, dimmed, while new data loads.
  main.classList.add("loading");
  refresh.disabled = true;
  try {
    const params = new URLSearchParams({ range: rangeSelect.value });
    if (appSelect.value) params.set("app", appSelect.value);
    const res = await fetch(`${GATEWAY_URL}/v1/stats?${params}`);
    if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
    const s = (await res.json()) as Stats;
    syncApps(s.apps);
    errorEl.hidden = true;
    render(s);
  } catch (err) {
    errorEl.textContent = `Could not load stats: ${err instanceof Error ? err.message : String(err)}. Is the gateway running at ${GATEWAY_URL}?`;
    errorEl.hidden = false;
  } finally {
    main.classList.remove("loading");
    refresh.disabled = false;
  }
}

rangeSelect.addEventListener("change", load);
appSelect.addEventListener("change", load);
refresh.addEventListener("click", load);

// Charts are drawn at the container's width, so redraw when it changes.
let resizeTimer = 0;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => last && renderCharts(last), 150);
}).observe(content);

load();
