// Splitting a file's pages into chunks for the index: paragraphs packed up to MAX chars, a longer paragraph cut at
// sentence ends, never across a page, so every chunk has one page to cite. Same MAX as the law chunks (etl/docs.py).
// The chunk's id is `<fileId>:<n>`: stable while CHUNKER is, so a citation of it holds until the file is re-chunked.
export const CHUNKER = "para1500@1";
const MAX = 1500;

export type FileChunk = { id: string; fileId: string; n: number; page: number; text: string };

export function chunkPages(fileId: string, pages: { n: number; text: string }[]): FileChunk[] {
  const out: FileChunk[] = [];
  const push = (page: number, text: string) => {
    const t = text.trim();
    if (t) out.push({ id: `${fileId}:${out.length}`, fileId, n: out.length, page, text: t });
  };
  for (const p of pages) {
    let cur = "";
    for (const para of pieces(p.text)) {
      if (cur && cur.length + para.length + 2 > MAX) {
        push(p.n, cur);
        cur = "";
      }
      cur = cur ? `${cur}\n\n${para}` : para;
    }
    push(p.n, cur);
  }
  return out;
}

/** Paragraphs, each at most MAX: a longer one is cut at sentence ends, then at spaces. */
function pieces(text: string): string[] {
  return text.split(/\n\s*\n/).flatMap((para) => {
    para = para.trim();
    if (para.length <= MAX) return para ? [para] : [];
    const out: string[] = [];
    let cur = "";
    for (const s of para.split(/(?<=[.;:?!])\s+/)) {
      for (const w of s.length > MAX ? s.match(new RegExp(`.{1,${MAX}}(\\s|$)`, "gs")) ?? [s] : [s]) {
        if (cur && cur.length + w.length + 1 > MAX) {
          out.push(cur);
          cur = "";
        }
        cur = cur ? `${cur} ${w.trim()}` : w.trim();
      }
    }
    if (cur) out.push(cur);
    return out;
  });
}
