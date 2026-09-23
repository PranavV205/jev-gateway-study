import questionsJson from "../../../corpus/questions.json";

export interface Doc {
  id: string;
  title: string;
  markdown: string;
}

export interface SampleQuestion {
  id: string;
  doc: string;
  task_type: string;
  question: string;
  answer: string;
}

const files = import.meta.glob("../../../corpus/documents/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const docs: Doc[] = Object.entries(files)
  .map(([path, markdown]) => ({
    id: path.split("/").pop()?.replace(/\.md$/, "") ?? path,
    title: markdown.match(/^#\s+(.+)$/m)?.[1] ?? path,
    markdown,
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

export const questions = questionsJson as SampleQuestion[];

export function questionsFor(docId: string): SampleQuestion[] {
  return questions.filter((q) => q.doc === docId);
}
