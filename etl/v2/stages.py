"""Stages 1-3 of pipeline v2 (docs/PIPELINE_V2.md), on today's spiders, downloader and engines.

  listing  every spider lists everything it sees, every language, no filter on what another source holds; rows are
           typed and upserted (source, source_url); each run also writes its rows to R2
           (<prefix>listings/<source>/<spider>/<date>.jsonl.gz)
  fetch    one file per document: language first (English, Sinhala, Tamil), then the type's source rank, then the
           human fixes (etl/overrides.json: pin, reject, rekey); a failed download falls to the next candidate;
           a file is stored once per sha256 (source/<sha256>.<ext>) with a manifest beside it (source/<sha256>.json)
  extract  one engine per page: docling on pages with a text layer; LightOnOCR-3 on English scans (an OCR server,
           V2_OCR_API); Sinhala/Tamil scans wait for docling + Surya (not set up here: the file is marked, not
           read); no docling pass over scanned pages (today's extract runs docling on the whole file)
"""
import gzip, hashlib, io, json, os, re, time
from datetime import date

from psycopg2.extras import Json, execute_values

from etl.v2 import build as B

LANG = ["ENGLISH", "SINHALA", "TAMIL"]
RANK = {"act": ["documents.gov.lk", "parliament.lk", "lankalaw", "commonlii"],
        "law": ["parliament.lk", "lankalaw", "commonlii"],
        "constitution_amendment": ["documents.gov.lk", "parliament.lk"],
        "revised_1980": ["lankalaw", "commonlii"]}


# -- stage 1: listing ------------------------------------------------------------------------------------------------

def _lang_of(url, lang):
    """lankalaw links documents.gov.lk's Sinhala/Tamil files as if English (_S.pdf / _T.pdf)."""
    return "SINHALA" if re.search(r"_S\.pdf$", url) else "TAMIL" if re.search(r"_T\.pdf$", url) else lang


def spider_rows(name, limit=None):
    """(v1 source name, url, title, date, meta) for one spider; meta as today's discover_* build it."""
    from etl.spiders import acts, gazettes, le1956, le1980, lankalaw, parliament
    if name == "documents.gov.lk/acts":
        recs = acts.crawl(limit=limit or 100, max_pages=1 if limit else None)
        return [("acts", acts.pdf_url(c["uploadedFile"]), r.get("descriptionEnglish"), r.get("date"),
                 {"act_no": r.get("actNoText"), "lang": c["language"], "listing": r})
                for r in recs for c in r.get("contents") or []]
    if name == "documents.gov.lk/gazettes":
        return [("gazette", acts.pdf_url(c["uploadedFile"]), r.get("descriptionEnglish"), r.get("date"),
                 {"gazette_no": r.get("gazetteNoText"), "lang": c["language"], "listing": r})
                for r in gazettes.crawl(limit=limit or 1000) if gazettes.is_law(r.get("descriptionEnglish"))
                for c in r.get("contents") or []]
    if name == "parliament.lk/acts":
        return [("parliament", r["url"], r["title"], r["date"],
                 {"act_no": r["act_no"], "kind": r["kind"], "lang": "ENGLISH", "listing": r}) for r in parliament.crawl()]
    if name == "parliament.lk/constitution":
        from etl.fetch import CONSTITUTION
        base = "https://www.parliament.lk/files/pdf/constitution/"
        return [("constitution", base + f, t, d, {"constitution": k, "lang": "ENGLISH", "listing": {"title": t},
                                                   **({"spread": True} if k == "constitution" else {})})
                for k, f, d, t in CONSTITUTION]
    if name == "lankalaw/acts-by-year":
        return [("lankalaw", r["url"], r["title"], f"{r['act_no'].split('/')[1]}-01-01",
                 {"act_no": r["act_no"], "lang": _lang_of(r["url"], "ENGLISH"), "format": r["format"],
                  "date_precision": "year", "listing": r}) for r in lankalaw.crawl(range(1956, 2027))]
    if name == "lankalaw/le1980":
        return [("le1980", r["url"], r["title"], None, {"cap": r["cap"], "lang": "ENGLISH", "listing": r}) for r in le1980.crawl()]
    if name == "lankalaw/le1956":
        return [("le1956", r["url"], r["title"], None, {"cap1956": r["cap"], "lang": "ENGLISH", "format": "html", "listing": r})
                for r in le1956.crawl()]
    raise SystemExit(f"no spider {name}")


SPIDERS = ["documents.gov.lk/acts", "documents.gov.lk/gazettes", "parliament.lk/acts", "parliament.lk/constitution",
           "lankalaw/acts-by-year", "lankalaw/le1980", "lankalaw/le1956"]


def listing(connect, name, limit=None):
    """Crawl first, then connect: a crawl takes minutes, and Neon closes a connection left idle that long
    (run 83e03e43, 2026-11-12)."""
    from etl.v2.run import SOURCES, v1_type
    rows = spider_rows(name, limit)
    out = []
    for src, url, title, d, meta in rows:
        source, spider = SOURCES[src]
        typ, key = v1_type(src, meta)
        fmt = "html" if meta.get("format") == "html" or url.lower().endswith((".html", ".htm")) else "pdf"
        out.append((source, spider, url, typ, key, title, d, meta.get("date_precision") or "day", meta.get("lang"),
                    fmt, Json({**meta.get("listing", {}), "v1_meta": meta})))
    uniq = list({(r[0], r[2]): r for r in out}.values())
    db = connect()
    try:
        with db, db.cursor() as cur:      # commits, or rolls back on an error
            execute_values(cur, """INSERT INTO listings (source, spider, source_url, type, listed_key, title, date, date_precision,
                                     language, format, listing) VALUES %s
                                   ON CONFLICT (source, source_url) DO UPDATE SET title = EXCLUDED.title, date = EXCLUDED.date,
                                     type = EXCLUDED.type, listed_key = EXCLUDED.listed_key, language = EXCLUDED.language,
                                     listing = listings.listing || EXCLUDED.listing, last_seen = NOW()""", uniq, page_size=2000)
    finally:
        db.close()
    s3, bucket = B.r2()
    body = gzip.compress("\n".join(json.dumps({"source": r[0], "spider": r[1], "url": r[2], "type": r[3], "key": r[4],
                                               "title": r[5], "date": r[6], "language": r[8], "format": r[9]},
                                              ensure_ascii=False) for r in uniq).encode())
    snap = f"{B.PREFIX}listings/{name}/{date.today()}.jsonl.gz"
    s3.put_object(Bucket=bucket, Key=snap, Body=body, ContentType="application/gzip")
    return {"rows": len(uniq), "snapshot": snap}


# -- stage 2: fetch --------------------------------------------------------------------------------------------------

def overrides():
    p = os.path.join(os.path.dirname(__file__), "..", "overrides.json")
    return json.load(open(p)) if os.path.exists(p) else {}


def candidates(db):
    """{key: [candidate listing, ...]} in pick order (pin first, then language, source rank, an extracted file)."""
    ov = overrides()
    reject = {r["listing"] for r in ov.get("reject", [])}
    rekey = {r["listing"]: r["key"] for r in ov.get("rekey", [])}
    pin = {r["key"]: r["listing"] for r in ov.get("pin", [])}
    with db.cursor() as cur:
        cur.execute("""SELECT l.id, l.source, l.type, l.listed_key, l.language, l.source_url, lf.sha256, f.raw_key, lf.error
                       FROM listings l LEFT JOIN listing_files lf ON lf.listing_id = l.id LEFT JOIN files f ON f.sha256 = lf.sha256""")
        rows = cur.fetchall()
    db.commit()
    by = {}
    for lid, source, typ, key, lang, url, sha, raw, err in rows:
        key = rekey.get(url, key)
        if key and url not in reject and not (key.startswith("other:")):
            by.setdefault(key, []).append({"id": lid, "source": source, "type": typ, "lang": lang, "url": url,
                                           "sha": sha, "raw": raw, "error": err})
    for key, cs in by.items():
        rank = RANK.get(cs[0]["type"], [])
        cs.sort(key=lambda c: (c["url"] != pin.get(key), LANG.index(c["lang"]) if c["lang"] in LANG else 9,
                               rank.index(c["source"]) if c["source"] in rank else 9, not c["raw"], not c["sha"], c["id"]))
    return by


def choose(db):
    """Pick a file per document (the first candidate whose file is held, else the first not yet failed) and write
    `documents`. -> keys whose first candidate needs downloading (the fetch stage's items)."""
    need, rows = [], []
    for key, cs in candidates(db).items():
        held = next((c for c in cs if c["sha"]), None)
        first = next((c for c in cs if not c["error"]), cs[0])
        if not held or (first["id"] != held["id"] and not first["sha"] and LANG.index(first["lang"] or "TAMIL") <
                        LANG.index(held["lang"] or "TAMIL")):
            need.append((key, f"{first['id']}|{first['url']}"))
        if held:
            how = "pin" if held is cs[0] and any(c["url"] == held["url"] for c in cs[:1]) else "rank"
            how = "language fallback" if held["lang"] != "ENGLISH" else how
            rows.append((key, held["type"], None, held["id"], held["sha"], held["lang"], how))
    with db.cursor() as cur:
        execute_values(cur, """INSERT INTO documents (key, type, title, listing_id, sha256, language, chosen_by) VALUES %s
                               ON CONFLICT (key) DO UPDATE SET listing_id = EXCLUDED.listing_id, sha256 = EXCLUDED.sha256,
                                 language = EXCLUDED.language, chosen_by = EXCLUDED.chosen_by, updated_at = NOW()""",
                       rows, page_size=2000)
        cur.execute("""UPDATE documents d SET title = l.title FROM listings l WHERE l.id = d.listing_id AND d.title IS NULL""")
    db.commit()
    return need


def manifest(s3, bucket, sha, ext, size, listings_):
    key = f"{B.PREFIX}source/{sha}.json"
    s3.put_object(Bucket=bucket, Key=key, ContentType="application/json", Body=json.dumps(
        {"sha256": sha, "bytes": size, "ext": ext, "content_type": "text/html" if ext == "html" else "application/pdf",
         "listings": listings_}, ensure_ascii=False).encode())
    return key


def fetch_one(db, item):
    """Download a document's next candidate (today's downloader, with its Wayback fallback); on failure the
    listing records the error and the next `choose` moves to the next candidate."""
    from etl.fetch import download
    lid, url = item.split("|", 1)
    s3, bucket = B.r2()
    _, sha, key, size, err = download(s3, bucket, set(), int(lid), url)
    with db.cursor() as cur:
        if err:
            cur.execute("""INSERT INTO listing_files (listing_id, error) VALUES (%s, %s)
                           ON CONFLICT (listing_id) DO UPDATE SET error = EXCLUDED.error""", (int(lid), err))
            db.commit()
            raise RuntimeError(err)
        ext = key.rsplit(".", 1)[-1]
        cur.execute("""INSERT INTO files (sha256, ext, bytes, content_type, r2_key) VALUES (%s,%s,%s,%s,%s)
                       ON CONFLICT (sha256) DO NOTHING""", (sha, ext, size, "text/html" if ext == "html" else "application/pdf", key))
        cur.execute("""INSERT INTO listing_files (listing_id, sha256, fetched_from, fetched_at, error) VALUES (%s,%s,%s,NOW(),NULL)
                       ON CONFLICT (listing_id) DO UPDATE SET sha256 = EXCLUDED.sha256, fetched_at = NOW(), error = NULL""",
                    (int(lid), sha, url))
        cur.execute("""SELECT l.source, l.source_url, lf.fetched_from, lf.fetched_at::text, l.type, l.listed_key, l.language
                       FROM listing_files lf JOIN listings l ON l.id = lf.listing_id WHERE lf.sha256 = %s""", (sha,))
        ls = [dict(zip(("source", "source_url", "fetched_from", "fetched_at", "type", "listed_key", "language"), r))
              for r in cur.fetchall()]
    db.commit()
    return {"sha256": sha, "manifest": manifest(s3, bucket, sha, ext, size, ls)}


# -- stage 3: extract ------------------------------------------------------------------------------------------------

def extract_one(db, sha):
    """One file: count text per page (pypdfium), docling on the pages with a text layer only; writes
    raw/v2/<sha256>.json.gz and files.raw_key. Scanned pages are left to the ocr stage (files.ocr_pages, ocr_lang)."""
    from etl import extract as X
    s3, bucket = B.r2()
    with db.cursor() as cur:
        cur.execute("""SELECT f.r2_key, (SELECT l.language FROM listing_files lf JOIN listings l ON l.id = lf.listing_id
                                          WHERE lf.sha256 = f.sha256 LIMIT 1) FROM files f WHERE f.sha256 = %s""", (sha,))
        key, lang = cur.fetchone()
    db.commit()
    blob = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    rkey = f"raw/{X.VERSION}/{sha}.json.gz"
    out = {}
    if key.endswith(".html"):
        raw = {"sha256": sha, "version": X.VERSION, "format": "html", "pages": [], "html": blob.decode("utf8", "replace"),
               "docling": X.docling_html(blob, sha), "chandra": None}
    else:
        pages = X.text_layer(blob)
        scan = [p["page_no"] for p in pages if X.is_scan(p)]
        digital = [p["page_no"] for p in pages if p["chars"] >= X.MIN_CHARS and not X.is_scan(p)]
        dl = X.docling(blob, sha, digital, None) if digital else None      # docling only where there is a text layer
        if dl and (not dl["status"].endswith("SUCCESS") or dl["status"].endswith("PARTIAL_SUCCESS")):
            raise RuntimeError(f"docling {dl['status']}")
        raw = {"sha256": sha, "version": X.VERSION, "pages": pages, "docling": dl, "chandra": None}
        out = {"pages": len(pages), "scanned": len(scan), "digital": len(digital)}
        if scan:
            out["ocr"] = f"waiting: {lang or 'ENGLISH'} scans for the ocr stage"
    s3.put_object(Bucket=bucket, Key=rkey, ContentType="application/gzip",
                  Body=gzip.compress(json.dumps(raw, ensure_ascii=False).encode()))
    with db.cursor() as cur:
        cur.execute("UPDATE files SET raw_key = %s, ocr_pages = %s, ocr_lang = %s WHERE sha256 = %s",
                    (rkey, out.get("scanned") or None, (lang or "ENGLISH") if out.get("scanned") else None, sha))
    db.commit()
    return out


# -- stage 3b: OCR (English scans) -----------------------------------------------------------------------------------

OCR_MODELS = {k: v for k, v in json.load(open(os.path.join(os.path.dirname(__file__), "ocr_models.json"))).items()
              if k != "_"}


def surya_one(db, sha, lang, blob, s3, bucket):
    """docling again over the whole file with Surya on the pages that have no text (etl.extract.docling, ocr="scan":
    digital pages keep their text layer), replacing the file's raw (raw/v2) and setting files.ocr_engine, which
    changes the build fingerprint. Needs docling-surya (Python 3.12): ada's sllaw_venv. Surya's weights cache:
    MODEL_CACHE_DIR (the worker sets /var/tmp/e19309/cache/datalab)."""
    from importlib.metadata import version
    from etl import extract as X
    with db.cursor() as cur:
        cur.execute("SELECT raw_key FROM files WHERE sha256 = %s", (sha,))
        rkey, = cur.fetchone()
    db.commit()
    raw = json.loads(gzip.decompress(s3.get_object(Bucket=bucket, Key=rkey)["Body"].read()))
    pages = raw.get("pages") or X.text_layer(blob)
    digital = [p["page_no"] for p in pages if p["chars"] >= X.MIN_CHARS and not X.is_scan(p)]
    dl = X.docling(blob, sha, digital, "scan")
    if not dl["status"].endswith("SUCCESS") or dl["status"].endswith("PARTIAL_SUCCESS"):
        raise RuntimeError(f"docling + Surya {dl['status']}")     # never store a partial read (CLAUDE.md)
    text = " ".join(t.get("text", "") for t in (dl.get("document") or {}).get("texts", []))
    share = script_share(text, lang)
    if share is not None and share < 0.5:
        raise RuntimeError(f"wrong script: {share:.0%} {lang} letters (docling + Surya)")
    engine = f"docling-surya {version('surya-ocr')}"
    raw = {**raw, "docling": dl, "ocr": {"engine": engine, "language": lang}}
    s3.put_object(Bucket=bucket, Key=rkey, ContentType="application/gzip",
                  Body=gzip.compress(json.dumps(raw, ensure_ascii=False).encode()))
    with db.cursor() as cur:
        cur.execute("UPDATE files SET ocr_engine = %s, ocr_pages = NULL WHERE sha256 = %s", (engine, sha))
    db.commit()
    return {"language": lang, "engine": engine, "scanned": sum(X.is_scan(p) for p in pages),
            "share": None if share is None else round(share, 2)}


SCRIPT = {"SINHALA": r"[\u0D80-\u0DFF]", "TAMIL": r"[\u0B80-\u0BFF]", "ENGLISH": r"[A-Za-z]"}


def script_share(text, lang):
    """Share of the letters that are in the language's script (None for too little text to say)."""
    letters = re.findall(r"[^\W\d_]", text)
    if len(letters) < 200:
        return None
    pat = re.compile(SCRIPT[lang])
    return sum(bool(pat.match(ch)) for ch in letters) / len(letters)


def ocr_page(api, prof, png_b64):
    """One page image -> (text, new tokens, finish reason), with the language's prompt and sampling."""
    import requests
    content = [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + png_b64}}]
    if prof["prompt"]:
        content.append({"type": "text", "text": prof["prompt"]})
    for attempt in range(3):
        try:
            r = requests.post(f"{api}/chat/completions", timeout=900, json={
                "model": "lighton", "messages": [{"role": "user", "content": content}], "max_tokens": prof["max_tokens"],
                "temperature": prof["temperature"], "top_p": prof["top_p"]})
            r.raise_for_status()
            j = r.json()
            return j["choices"][0]["message"]["content"], j["usage"]["completion_tokens"], j["choices"][0]["finish_reason"]
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(10)


def ocr_one(db, sha):
    """LightOn on one file's scanned pages, with the model of the file's language (ocr_models.json; the server in
    V2_OCR_API, which the pipeline's ocr op starts per language on a free GPU): writes raw/lighton/<sha256>.json.gz
    and sets files.lighton, which changes the file's build fingerprint, so the next build reads the OCR text.
    Only once every page came back."""
    import base64, io, threading
    from concurrent.futures import ThreadPoolExecutor
    import pypdfium2
    from etl import extract as X
    s3, bucket = B.r2()
    with db.cursor() as cur:
        cur.execute("SELECT r2_key, coalesce(ocr_lang, 'ENGLISH') FROM files WHERE sha256 = %s", (sha,))
        key, lang = cur.fetchone()
    db.commit()
    prof = OCR_MODELS[lang]
    blob = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    if prof["engine"] == "docling-surya":
        return surya_one(db, sha, lang, blob, s3, bucket)
    api = os.environ["V2_OCR_API"]                   # a LightOn server (the pipeline's ocr op starts it)
    want = [p["page_no"] for p in X.text_layer(blob) if X.is_scan(p)]
    pdf, lock = pypdfium2.PdfDocument(blob), threading.Lock()

    def page(n):
        with lock:                                   # pdfium is not thread-safe
            im = pdf[n - 1].render(scale=prof["dpi"] / 72).to_pil()
        im.thumbnail((prof["edge"], prof["edge"]))
        buf = io.BytesIO()
        im.convert("RGB").save(buf, format="PNG")
        return ocr_page(api, prof, base64.b64encode(buf.getvalue()).decode())
    with ThreadPoolExecutor(16) as pool:
        res = list(pool.map(page, want))
    share = script_share("\n".join(md for md, _, _ in res), lang)
    if share is not None and share < 0.5:          # the model wrote another script: never store it (2026-11-08:
        raise RuntimeError(f"wrong script: {share:.0%} {lang} letters")   # the Sinhala merge wrote Gujarati)
    out = {"sha256": sha, "model": os.path.basename(prof["model"]), "language": lang,
           "params": {k: prof[k] for k in ("prompt", "dpi", "edge", "temperature", "top_p", "max_tokens")},
           "pages": [{"page_no": n, "md": md, "tokens": t, "finish": fin} for n, (md, t, fin) in zip(want, res)]}
    s3.put_object(Bucket=bucket, Key=f"raw/lighton/{sha}.json.gz", ContentType="application/gzip",
                  Body=gzip.compress(json.dumps(out, ensure_ascii=False).encode()))
    with db.cursor() as cur:
        cur.execute("UPDATE files SET lighton = TRUE, ocr_pages = NULL WHERE sha256 = %s", (sha,))
    db.commit()
    return {"language": lang, "pages": len(want), "cut": sum(fin != "stop" for _, _, fin in res)}
