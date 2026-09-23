import { describe, expect, it } from "vitest";
import contract from "../../../corpus/documents/contract-northwind-supply.md?raw";
import invoice from "../../../corpus/documents/invoice-northwind-2041.md?raw";
import lease from "../../../corpus/documents/lease-alder-street.md?raw";
import { chunkDocument, rankChunks, retrieve, tokenize } from "../src/retrieve";

describe("chunkDocument", () => {
  it("starts a new chunk at each heading and keeps tables whole", () => {
    const chunks = chunkDocument(
      "doc",
      "# Title\n\nIntro.\n\n## A\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n## B\n\nText.",
    );
    expect(chunks.map((c) => c.text.split("\n")[0])).toEqual(["# Title", "## A", "## B"]);
    expect(chunks[1]?.text).toContain("| 1 | 2 |");
    expect(chunks[2]).toMatchObject({ id: "doc#3", source: "doc.md#3" });
  });

  it("keeps every chunk of a long document near the target size", () => {
    const chunks = chunkDocument("contract", contract);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.text.split(/\s+/).length).toBeLessThan(260);
  });
});

describe("tokenize", () => {
  it("lowercases, drops stopwords, and keeps numbers with separators", () => {
    expect(tokenize("What is the total of $12,214.80?")).toEqual(["total", "12,214.80"]);
  });
});

describe("retrieve", () => {
  const chunks = chunkDocument("lease", lease);

  it("ranks the section that answers the question first", () => {
    const [top] = rankChunks("How many parking spaces are included?", chunks);
    expect(top?.chunk.text).toContain("## 7. Parking");
  });

  it("returns at most k chunks in document order", () => {
    const got = retrieve("security deposit and renewal option", chunks, 3);
    expect(got).toHaveLength(3);
    const ids = got.map((c) => Number(c.id.split("#")[1]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("returns every chunk when the document is small", () => {
    const small = chunkDocument("inv", invoice);
    expect(retrieve("total due", small, 5)).toEqual(small);
  });
});
