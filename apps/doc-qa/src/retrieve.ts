// Splits a Markdown document into chunks and ranks them against a question with BM25.
// Deliberately simple: the demo app only needs to hand the gateway a few relevant chunks.

export interface Chunk {
  id: string;
  text: string;
  source: string;
}

const TARGET_WORDS = 180;

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

// Blocks are separated by blank lines, so a Markdown table stays in one block.
// Consecutive blocks are packed into chunks of about TARGET_WORDS words, and a
// heading always starts a new chunk so sections stay together.
export function chunkDocument(docId: string, markdown: string): Chunk[] {
  const blocks = markdown
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const groups: string[][] = [];
  let current: string[] = [];
  let words = 0;
  for (const block of blocks) {
    const startsSection = /^#{1,6}\s/.test(block);
    if (current.length && (startsSection || words + wordCount(block) > TARGET_WORDS)) {
      groups.push(current);
      current = [];
      words = 0;
    }
    current.push(block);
    words += wordCount(block);
  }
  if (current.length) groups.push(current);

  return groups.map((g, i) => ({
    id: `${docId}#${i + 1}`,
    text: g.join("\n\n"),
    source: `${docId}.md#${i + 1}`,
  }));
}

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i if in is it its me my of on or our so that the this to was we what when where which who why will with would you your".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:[.,][0-9]+)*/g) ?? []).filter((t) => !STOPWORDS.has(t));
}

// Okapi BM25 over the given chunks. Returns chunks sorted by score, highest first.
export function rankChunks(question: string, chunks: Chunk[], k1 = 1.5, b = 0.75): { chunk: Chunk; score: number }[] {
  const docs = chunks.map((c) => tokenize(c.text));
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / Math.max(docs.length, 1);
  const docFreq = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);

  const terms = [...new Set(tokenize(question))];
  const n = chunks.length;
  return chunks
    .map((chunk, i) => {
      const doc = docs[i] ?? [];
      let score = 0;
      for (const t of terms) {
        const tf = doc.filter((x) => x === t).length;
        if (!tf) continue;
        const df = docFreq.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLen)));
      }
      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score);
}

// The top `k` chunks, returned in document order so the model reads them in sequence.
export function retrieve(question: string, chunks: Chunk[], k = 5): Chunk[] {
  if (chunks.length <= k) return chunks;
  const top = new Set(
    rankChunks(question, chunks)
      .slice(0, k)
      .map((r) => r.chunk.id),
  );
  return chunks.filter((c) => top.has(c.id));
}
