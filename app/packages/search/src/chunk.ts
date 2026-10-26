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

/** Paragraphs, each at most MAX: a longer one is cut at sentence ends, a longer sentence by cut(). */
function pieces(text: string): string[] {
  return text.split(/\n\s*\n/).flatMap((para) => {
    para = para.trim();
    if (para.length <= MAX) return para ? [para] : [];
    const out: string[] = [];
    let cur = "";
    for (const s of para.split(/(?<=[.;:?!])\s+/).flatMap(cut)) {
      if (cur && cur.length + s.length + 1 > MAX) {
        out.push(cur);
        cur = "";
      }
      cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) out.push(cur);
    return out;
  });
}

/** A sentence in pieces of at most MAX: at the last whitespace that fits, or at MAX when there is none (a run with no
 *  spaces: a URL, base64, OCR noise). Only the whitespace cut at is dropped, never text. */
export function cut(s: string): string[] {
  const out: string[] = [];
  s = s.trim();
  while (s.length > MAX) {
    const ws = s.slice(0, MAX + 1).search(/\s\S*$/); // the last whitespace within MAX + 1 chars
    let at = ws > 0 ? ws : MAX;
    if (ws <= 0 && /[\uD800-\uDBFF]/.test(s[at - 1]!)) at--; // never split a surrogate pair (emoji)
    out.push(s.slice(0, at).trimEnd());
    s = s.slice(at).trimStart();
  }
  if (s) out.push(s);
  return out;
}
