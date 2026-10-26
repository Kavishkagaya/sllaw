import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extract, extractors, httpOcr, mistralOcr, NoText, ocrFromEnv, Unreadable, type OcrProvider } from ".";

const enc = (s: string) => new TextEncoder().encode(s);
const LONG = "The petitioner states that the respondent unlawfully entered the land in dispute.";

/** A minimal PDF with one text line per page; an empty string is a page with no text layer (a scan). */
function pdf(pages: string[]) {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const font = 3 + pages.length * 2;
  pages.forEach((t, i) => {
    const s = t ? `BT /F1 12 Tf 72 720 Td (${t}) Tj ET` : "";
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return enc(out);
}

/** An OCR provider that records its calls and returns "ocr text <n>" for every page. */
function fakeOcr(pagesOf: (mime: string) => number) {
  const calls: { url: string; mime: string; filename: string }[] = [];
  const provider: OcrProvider = {
    by: "fake-ocr@1",
    async ocr(file) {
      calls.push(file);
      return Array.from({ length: pagesOf(file.mime) }, (_, i) => `ocr text ${i + 1}`);
    },
  };
  return { provider, calls };
}
const ctx = { url: async () => "https://store.example/signed" };

describe("PDFs without OCR", () => {
  it("reads a text layer page by page", async () => {
    const x = await extract(pdf([LONG, LONG.replace("petitioner", "plaintiff")]), "application/pdf", "p.pdf");
    expect(x.by).toBe("unpdf@1");
    expect(x.pages).toHaveLength(2);
    expect(x.pages[1]!.text).toMatch(/plaintiff/);
  });

  it("says a scanned PDF needs OCR", async () => {
    await expect(extract(pdf(["", ""]), "application/pdf", "scan.pdf")).rejects.toSatisfy(
      (e) => e instanceof NoText && e.reason === "needs_ocr",
    );
  });

  it("calls bytes it cannot parse Unreadable", async () => {
    await expect(extract(enc("%PDF-1.4 not really a pdf"), "application/pdf", "bad.pdf")).rejects.toBeInstanceOf(Unreadable);
  });

  it("says no extractor reads an image", async () => {
    await expect(extract(new Uint8Array([1]), "image/png", "photo.png")).rejects.toSatisfy(
      (e) => e instanceof NoText && e.reason === "unsupported",
    );
  });
});

describe("OCR", () => {
  it("sends the whole file once as a signed URL; pages with a text layer keep theirs", async () => {
    const { provider, calls } = fakeOcr((m) => (m === "application/pdf" ? 20 : 1));
    const pages = Array.from({ length: 20 }, (_, i) => (i === 0 ? LONG : ""));
    const x = await extract(pdf(pages), "application/pdf", "scan.pdf", extractors(provider), ctx);
    expect(x.by).toBe("unpdf+ocr:fake-ocr@1@1");
    expect(x.pages).toHaveLength(20);
    expect(x.pages[0]!.text).toMatch(/petitioner/);
    expect(x.pages[1]!.text).toBe("ocr text 2");
    expect(calls).toEqual([{ url: "https://store.example/signed", mime: "application/pdf", filename: "scan.pdf" }]);
  });

  it("is not called for a PDF with a text layer on every page", async () => {
    const { provider, calls } = fakeOcr(() => 2);
    await extract(pdf([LONG, LONG]), "application/pdf", "t.pdf", extractors(provider), ctx);
    expect(calls).toHaveLength(0);
  });

  it("reads images when a provider is set", async () => {
    const { provider } = fakeOcr(() => 1);
    const img = await extract(new Uint8Array([1, 2, 3]), "image/png", "photo.png", extractors(provider), ctx);
    expect(img.pages[0]!.text).toBe("ocr text 1");
  });

  it("fails without a URL to send (memory store), not to be retried", async () => {
    const { provider } = fakeOcr(() => 2);
    await expect(extract(pdf(["", ""]), "application/pdf", "s.pdf", extractors(provider))).rejects.toMatchObject({
      message: expect.stringMatching(/no URL/),
      retryable: false,
    });
  });
});

describe("httpOcr", () => {
  it("is off without OCR_URL", () => {
    expect(httpOcr({})).toBeNull();
  });

  it("posts the URL with the token and returns the pages in order", async () => {
    const srv = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c)).on("end", () => {
        res.setHeader("content-type", "application/json");
        const auth = req.headers.authorization;
        res.end(JSON.stringify({ pages: [{ n: 2, text: "two" }, { n: 1, text: `one ${JSON.parse(b).url} ${auth}` }] }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, r));
    try {
      const port = (srv.address() as { port: number }).port;
      const http = httpOcr({ OCR_URL: `http://127.0.0.1:${port}/ocr`, OCR_TOKEN: "t0k", OCR_NAME: "test" })!;
      expect(http.by).toBe("test@1");
      expect(await http.ocr({ url: "u", mime: "application/pdf", filename: "f.pdf" })).toEqual(["one u Bearer t0k", "two"]);
    } finally {
      srv.close();
    }
  });

  it("marks a network error retryable and an HTTP error with its status", async () => {
    const down = httpOcr({ OCR_URL: "http://127.0.0.1:9/ocr" })!;
    await expect(down.ocr({ url: "u", mime: "image/png", filename: "p.png" })).rejects.toMatchObject({ retryable: true });

    const srv = createServer((_, res) => {
      res.statusCode = 400;
      res.end("bad file");
    });
    await new Promise<void>((r) => srv.listen(0, r));
    try {
      const port = (srv.address() as { port: number }).port;
      const http = httpOcr({ OCR_URL: `http://127.0.0.1:${port}/ocr` })!;
      await expect(http.ocr({ url: "u", mime: "image/png", filename: "p.png" })).rejects.toMatchObject({ status: 400 });
    } finally {
      srv.close();
    }
  });
});

describe("mistralOcr", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is off unless OCR_PROVIDER=mistral, and needs a key then", () => {
    expect(ocrFromEnv({ MISTRAL_API_KEY: "k" })).toBeNull();
    expect(() => ocrFromEnv({ OCR_PROVIDER: "mistral" })).toThrow(/MISTRAL_API_KEY/);
    expect(ocrFromEnv({ OCR_PROVIDER: "mistral", MISTRAL_API_KEY: "k" })?.by).toBe("mistral:mistral-ocr-latest@1");
  });

  it("sends the signed URL as a document or an image, and returns the pages in order without image placeholders", async () => {
    const sent: { url: string; auth: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, auth: (init.headers as Record<string, string>).Authorization!, body: JSON.parse(init.body as string) });
      return Response.json({ pages: [{ index: 1, markdown: "two" }, { index: 0, markdown: "one ![img-0.jpeg](img-0.jpeg)" }] });
    });
    const m = mistralOcr({ MISTRAL_API_KEY: "k", MISTRAL_OCR_MODEL: "mistral-ocr-2512" });
    expect(m.by).toBe("mistral:mistral-ocr-2512@1");
    expect(await m.ocr({ url: "https://s/f.pdf", mime: "application/pdf", filename: "f.pdf" })).toEqual(["one", "two"]);
    await m.ocr({ url: "https://s/p.png", mime: "image/png", filename: "p.png" });
    expect(sent[0]).toEqual({
      url: "https://api.mistral.ai/v1/ocr", auth: "Bearer k",
      body: { model: "mistral-ocr-2512", document: { type: "document_url", document_url: "https://s/f.pdf" } },
    });
    expect(sent[1]!.body.document).toEqual({ type: "image_url", image_url: "https://s/p.png" });
  });

  it("stops when the step's signal aborts, with the step's own reason", async () => {
    vi.stubGlobal("fetch", (_: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const ac = new AbortController();
    const why = Object.assign(new Error("extract took longer than 240 s"), { retryable: true });
    const p = mistralOcr({ MISTRAL_API_KEY: "k" }).ocr({ url: "u", mime: "application/pdf", filename: "f.pdf" }, ac.signal);
    ac.abort(why);
    await expect(p).rejects.toBe(why);
  });

  it("an HTTP error carries its status (401: a bad key, not retried)", async () => {
    vi.stubGlobal("fetch", async () => new Response("unauthorized", { status: 401 }));
    await expect(mistralOcr({ MISTRAL_API_KEY: "bad" }).ocr({ url: "u", mime: "application/pdf", filename: "f.pdf" })).rejects.toMatchObject({ status: 401 });
  });
});
