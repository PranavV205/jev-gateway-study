// Small hand-drawn SVG charts. Specs: bars at most 24px thick with a 4px rounded data end,
// a 2px surface gap between stacked segments, 2px lines, 8px dots with a 2px surface
// ring, hairline solid gridlines, and a hover tooltip on every mark. Colors come from CSS
// custom properties so light and dark mode swap in one place. All text uses textContent.

const NS = "http://www.w3.org/2000/svg";

export interface Series {
  name: string;
  color: string; // a CSS color, usually var(--series-n)
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function html<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// ---------- tooltip ----------

const tooltip = () => document.getElementById("tooltip") as HTMLDivElement;

interface TipRow {
  color?: string;
  line?: boolean;
  label: string;
  value: string;
}

function showTip(event: PointerEvent | FocusEvent, title: string, rows: TipRow[]) {
  const tip = tooltip();
  tip.replaceChildren(html("div", title, "tip-title"));
  for (const r of rows) {
    const row = html("div", undefined, "tip-row");
    if (r.color) {
      const key = html("span", undefined, r.line ? "tip-key line" : "tip-key");
      key.style.background = r.color;
      row.append(key);
    }
    row.append(html("strong", r.value), html("span", r.label, "tip-label"));
    tip.append(row);
  }
  tip.hidden = false;

  let x: number;
  let y: number;
  if (event instanceof PointerEvent) {
    x = event.clientX;
    y = event.clientY;
  } else {
    const box = (event.target as Element).getBoundingClientRect();
    x = box.left + box.width / 2;
    y = box.top;
  }
  const { width, height } = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, x + 14));
  const top = y + 14 + height > window.innerHeight ? y - height - 14 : y + 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function hideTip() {
  tooltip().hidden = true;
}

// Wires hover and keyboard focus on a hit target to the shared tooltip.
function hover(target: SVGElement, lift: SVGElement, title: string, rows: () => TipRow[]) {
  target.setAttribute("tabindex", "0");
  target.setAttribute("role", "img");
  target.setAttribute(
    "aria-label",
    `${title}: ${rows()
      .map((r) => `${r.label} ${r.value}`)
      .join(", ")}`,
  );
  const on = (e: PointerEvent | FocusEvent) => {
    lift.classList.add("lifted");
    showTip(e, title, rows());
  };
  const off = () => {
    lift.classList.remove("lifted");
    hideTip();
  };
  target.addEventListener("pointermove", on);
  target.addEventListener("focus", on);
  target.addEventListener("pointerleave", off);
  target.addEventListener("blur", off);
}

// ---------- shared pieces ----------

// Round tick steps: 1, 2, or 5 times a power of ten.
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  if ((ticks.at(-1) ?? 0) < max) ticks.push(Number(((ticks.at(-1) ?? 0) + step).toPrecision(12)));
  return ticks;
}

// A bar with a 4px rounded data end and a square end at the baseline.
function roundedBar(x: number, y: number, w: number, h: number, end: "top" | "right" | "none", fill: string) {
  const r = Math.min(4, end === "top" ? h : w, end === "top" ? w / 2 : h / 2);
  if (end === "none" || r <= 0) return svg("rect", { x, y, width: w, height: Math.max(0, h), fill });
  const d =
    end === "top"
      ? `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`
      : `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
  return svg("path", { d, fill });
}

function legend(items: { name: string; color: string; line?: boolean }[]) {
  const box = html("div", undefined, "legend");
  for (const i of items) {
    const item = html("span", undefined, "legend-item");
    const key = html("span", undefined, i.line ? "legend-key line" : "legend-key");
    key.style.background = i.color;
    item.append(key, html("span", i.name));
    box.append(item);
  }
  return box;
}

function dataTable(headers: string[], rows: (string | number)[][]) {
  const details = html("details", undefined, "table-view");
  details.append(html("summary", "Show data table"));
  const table = html("table", undefined, "data");
  const head = html("tr");
  for (const h of headers) head.append(html("th", h));
  table.append(html("thead"));
  table.tHead?.append(head);
  const body = html("tbody");
  for (const r of rows) {
    const tr = html("tr");
    for (const c of r) tr.append(html("td", String(c)));
    body.append(tr);
  }
  table.append(body);
  details.append(table);
  return details;
}

function emptyNote(el: HTMLElement, text: string) {
  el.replaceChildren(html("p", text, "detail"));
}

// ---------- stacked columns with an optional reference line ----------

export interface ColumnsSpec {
  categories: string[];
  labels: string[]; // x-axis labels, same length as categories
  series: (Series & { values: number[] })[];
  line?: { name: string; color: string; values: number[] };
  format: (v: number) => string;
  axisFormat: (v: number) => string;
}

export function stackedColumns(el: HTMLElement, spec: ColumnsSpec) {
  if (!spec.categories.length) return emptyNote(el, "No data in this range.");
  const width = Math.max(280, el.clientWidth);
  const height = 240;
  const m = { top: 12, right: 12, bottom: 28, left: 60 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const n = spec.categories.length;

  const totals = spec.categories.map((_, i) => spec.series.reduce((s, se) => s + (se.values[i] ?? 0), 0));
  const ticks = niceTicks(Math.max(...totals, ...(spec.line?.values ?? [0])));
  const yMax = ticks.at(-1) ?? 1;
  const y = (v: number) => m.top + plotH - (v / yMax) * plotH;
  const band = plotW / n;
  const barW = Math.min(24, band * 0.6);
  const cx = (i: number) => m.left + band * i + band / 2;

  const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "chart-svg" });
  for (const t of ticks) {
    root.append(svg("line", { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? "axis" : "grid" }));
    const label = svg("text", {
      x: m.left - 8,
      y: y(t),
      class: "tick",
      "text-anchor": "end",
      "dominant-baseline": "middle",
    });
    label.textContent = spec.axisFormat(t);
    root.append(label);
  }

  // Leave about 96px per x label so dates never collide.
  const every = Math.ceil(n / Math.max(1, Math.floor(plotW / 96)));
  spec.labels.forEach((l, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    const t = svg("text", { x: cx(i), y: height - 8, class: "tick", "text-anchor": "middle" });
    t.textContent = l;
    root.append(t);
  });

  spec.categories.forEach((_, i) => {
    const g = svg("g", { class: "mark" });
    let base = 0;
    const visible = spec.series.map((s, k) => ({ s, k, v: s.values[i] ?? 0 })).filter((x) => x.v > 0);
    visible.forEach(({ s, v }, j) => {
      const top = base + v;
      const isTop = j === visible.length - 1;
      const y0 = y(base);
      const y1 = y(top);
      // 2px surface gap above every segment that has another segment on top of it.
      const h = Math.max(0, y0 - y1 - (isTop ? 0 : 2));
      if (h > 0) g.append(roundedBar(cx(i) - barW / 2, y0 - h, barW, h, isTop ? "top" : "none", s.color));
      base = top;
    });
    root.append(g);
  });

  if (spec.line) {
    const pts = spec.line.values.map((v, i) => `${cx(i)},${y(v)}`).join(" ");
    root.append(svg("polyline", { points: pts, class: "ref-line", stroke: spec.line.color }));
    spec.line.values.forEach((v, i) => {
      root.append(svg("circle", { cx: cx(i), cy: y(v), r: 4, fill: spec.line?.color ?? "", class: "dot" }));
    });
  }

  // One hit target per category, the full height of the plot: bigger than the mark.
  spec.categories.forEach((c, i) => {
    const hit = svg("rect", { x: m.left + band * i, y: m.top, width: band, height: plotH, class: "hit" });
    const lift = root.querySelectorAll("g.mark")[i] as SVGElement;
    hover(hit, lift, c, () => [
      ...spec.series.map((s) => ({ color: s.color, label: s.name, value: spec.format(s.values[i] ?? 0) })),
      { label: "Total", value: spec.format(totals[i] ?? 0) },
      ...(spec.line
        ? [{ color: spec.line.color, line: true, label: spec.line.name, value: spec.format(spec.line.values[i] ?? 0) }]
        : []),
    ]);
    root.append(hit);
  });

  el.replaceChildren(
    legend([...spec.series, ...(spec.line ? [{ name: spec.line.name, color: spec.line.color, line: true }] : [])]),
    root,
    dataTable(
      ["Period", ...spec.series.map((s) => s.name), "Total", ...(spec.line ? [spec.line.name] : [])],
      spec.categories.map((c, i) => [
        c,
        ...spec.series.map((s) => spec.format(s.values[i] ?? 0)),
        spec.format(totals[i] ?? 0),
        ...(spec.line ? [spec.format(spec.line.values[i] ?? 0)] : []),
      ]),
    ),
  );
}

// ---------- horizontal (stacked) bars ----------

export interface BarsSpec {
  rows: { label: string; values: number[] }[];
  series: Series[];
  format: (v: number) => string;
}

export function horizontalBars(el: HTMLElement, spec: BarsSpec) {
  if (!spec.rows.length) return emptyNote(el, "No data in this range.");
  const width = Math.max(280, el.clientWidth);
  const rowH = 36;
  const barH = 20;
  const labelW = Math.min(150, width * 0.4);
  const valueW = 48;
  const height = spec.rows.length * rowH + 8;
  const plotW = width - labelW - valueW;
  const totals = spec.rows.map((r) => r.values.reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const x = (v: number) => (v / max) * plotW;

  const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "chart-svg" });
  root.append(svg("line", { x1: labelW, x2: labelW, y1: 0, y2: height, class: "axis" }));

  spec.rows.forEach((r, i) => {
    const yMid = 4 + i * rowH + rowH / 2;
    const label = svg("text", {
      x: labelW - 8,
      y: yMid,
      class: "label",
      "text-anchor": "end",
      "dominant-baseline": "middle",
    });
    label.textContent = r.label;
    root.append(label);

    const g = svg("g", { class: "mark" });
    let left = labelW;
    const visible = r.values.map((v, k) => ({ v, k })).filter((p) => p.v > 0);
    visible.forEach(({ v, k }, j) => {
      const isEnd = j === visible.length - 1;
      const w = Math.max(0, x(v) - (isEnd ? 0 : 2));
      if (w > 0)
        g.append(roundedBar(left, yMid - barH / 2, w, barH, isEnd ? "right" : "none", spec.series[k]?.color ?? ""));
      left += x(v);
    });
    root.append(g);

    const value = svg("text", { x: left + 6, y: yMid, class: "value", "dominant-baseline": "middle" });
    value.textContent = spec.format(totals[i] ?? 0);
    root.append(value);

    const hit = svg("rect", { x: 0, y: 4 + i * rowH, width, height: rowH, class: "hit" });
    hover(hit, g, r.label, () =>
      spec.series.length > 1
        ? spec.series.map((s, k) => ({ color: s.color, label: s.name, value: spec.format(r.values[k] ?? 0) }))
        : [{ color: spec.series[0]?.color, label: spec.series[0]?.name ?? "", value: spec.format(totals[i] ?? 0) }],
    );
    root.append(hit);
  });

  el.replaceChildren(
    ...(spec.series.length > 1 ? [legend(spec.series)] : []),
    root,
    dataTable(
      ["", ...spec.series.map((s) => s.name)],
      spec.rows.map((r) => [r.label, ...spec.series.map((_, k) => spec.format(r.values[k] ?? 0))]),
    ),
  );
}

// ---------- histogram of scores in [0, 1] ----------

export interface HistogramSpec {
  bins: number[];
  threshold: number;
  thresholdLabel: string;
  color: string;
  unit: string; // "chunks", "questions"
}

export function histogram(el: HTMLElement, spec: HistogramSpec) {
  const total = spec.bins.reduce((a, b) => a + b, 0);
  if (!total) return emptyNote(el, "Nothing screened in this range.");
  const width = Math.max(280, el.clientWidth);
  const height = 200;
  const m = { top: 20, right: 12, bottom: 28, left: 44 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const ticks = niceTicks(Math.max(...spec.bins), 3).map((t) => Math.round(t));
  const yMax = ticks.at(-1) ?? 1;
  const y = (v: number) => m.top + plotH - (v / yMax) * plotH;
  const band = plotW / spec.bins.length;
  const barW = Math.min(24, band - 2);
  const xAt = (score: number) => m.left + score * plotW;

  const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "chart-svg" });
  for (const t of [...new Set(ticks)]) {
    root.append(svg("line", { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? "axis" : "grid" }));
    const label = svg("text", {
      x: m.left - 8,
      y: y(t),
      class: "tick",
      "text-anchor": "end",
      "dominant-baseline": "middle",
    });
    label.textContent = String(t);
    root.append(label);
  }
  for (const s of [0, 0.5, 1]) {
    const t = svg("text", {
      x: xAt(s),
      y: height - 8,
      class: "tick",
      "text-anchor": s === 0 ? "start" : s === 1 ? "end" : "middle",
    });
    t.textContent = s.toFixed(1);
    root.append(t);
  }

  spec.bins.forEach((count, i) => {
    const g = svg("g", { class: "mark" });
    const h = y(0) - y(count);
    if (count > 0) g.append(roundedBar(m.left + band * i + (band - barW) / 2, y(count), barW, h, "top", spec.color));
    root.append(g);
    const lo = (i / spec.bins.length).toFixed(1);
    const hi = ((i + 1) / spec.bins.length).toFixed(1);
    const hit = svg("rect", { x: m.left + band * i, y: m.top, width: band, height: plotH, class: "hit" });
    hover(hit, g, `Score ${lo} to ${hi}`, () => [{ color: spec.color, label: spec.unit, value: String(count) }]);
    root.append(hit);
  });

  const tx = xAt(spec.threshold);
  root.append(svg("line", { x1: tx, x2: tx, y1: m.top - 6, y2: y(0), class: "threshold" }));
  const tl = svg("text", { x: tx + 4, y: m.top - 8, class: "tick" });
  tl.textContent = spec.thresholdLabel;
  root.append(tl);

  el.replaceChildren(
    root,
    dataTable(
      ["Score", spec.unit],
      spec.bins.map((c, i) => [`${(i / 10).toFixed(1)} to ${((i + 1) / 10).toFixed(1)}`, c]),
    ),
  );
}
