#!/usr/bin/env python3
"""Acts spider: crawl documents.gov.lk and fetch PDFs. Nothing else.

Responsibility stops at "resource on disk" — parsing and persistence live
elsewhere. Writes <out>/*.pdf plus a manifest.jsonl of one record per act.

  python3 etl/spiders/acts.py --out corpus
  python3 etl/spiders/acts.py --search "inland revenue" --lang ENGLISH
  python3 etl/spiders/acts.py --pages 3 --limit 50 --list

The site was rebuilt as a Next.js app in 2026 (the old
documents.gov.lk/view/act/acts_<year>.html index is gone). There is no public
REST API: the listing table is a React Server Component whose paging goes
through a Server Action, so we invoke that the same way the browser does.
"""
import argparse, json, os, re, sys, time, urllib.parse, urllib.request

PAGE = "https://documents.gov.lk/web/acts"
FILE = "https://documents.gov.lk/api/content-file-proxy?file="
UA   = {"User-Agent": "sllaw-spider/1.0"}
DEC  = json.JSONDecoder()


def _get(url, data=None, headers=None, tries=4):
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if i == tries - 1:
                raise SystemExit(f"{url}\n  HTTP {e.code}: {e.read()[:200].decode('utf8','replace')}")
            time.sleep(2 ** i)
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 ** i)


def discover():
    """The Server Action id and the internal endpoint it proxies to are both
    build-specific — they change on every redeploy, so never hard-code them."""
    html = _get(PAGE).decode("utf8", "replace")
    ep = re.search(r'apiEndpoint\\?":\\?"([^"\\]+act/get-all)', html)
    for chunk in dict.fromkeys(re.findall(r'/_next/static/chunks/[\w/-]+\.js', html)):
        js = _get("https://documents.gov.lk" + chunk).decode("utf8", "replace")
        m = re.search(r'createServerReference\)?\("([0-9a-f]{20,})"[^)]*?"TableDataAction"\)', js)
        if m:
            return m.group(1), (ep.group(1) if ep else "")
    raise SystemExit("could not find TableDataAction — the site layout changed")


def search(action, endpoint, q=None, page=1, limit=100):
    args = {"apiEndpoint": endpoint, "page": page, "limit": limit}
    if q:
        args["q"] = args["search"] = q          # the site sends both
    body = _get(PAGE, data=json.dumps([args]).encode(),
                headers={"Next-Action": action, "Referer": PAGE,
                         "Content-Type": "text/plain;charset=UTF-8"}).decode("utf8", "replace")
    # RSC flight rows are "<id>:<json>", and the payload itself contains raw
    # newlines, so seek the row rather than splitting on lines
    m = re.search(r'^\d+:(?=\{"data")', body, re.M)
    if not m:
        raise SystemExit(f"unexpected action response: {body[:200]}")
    return DEC.raw_decode(body, m.end())[0]


def crawl(q=None, limit=100, max_pages=None):
    """Yield act records across all result pages."""
    action, endpoint = discover()
    page, pages, seen = 1, None, set()
    while True:
        d = search(action, endpoint, q, page, limit)
        items = d.get("data") or d.get("items") or []
        pg = d.get("pagination") or {}
        # upstream ordering is not stable across pages, so paging drops a few
        # records; it accepts any limit, so ask for the whole set in one page
        if page == 1 and max_pages is None and int(pg.get("total") or 0) > limit:
            limit = int(pg["total"])
            continue
        pages = pages or int(pg.get("totalPages") or 1)
        # the upstream ordering is not stable across pages, so the same act can
        # surface twice; dedupe by id rather than trusting page boundaries
        for it in items:
            if it.get("id") not in seen:
                seen.add(it.get("id"))
                yield it
        if not items or page >= min(pages, max_pages or pages):
            return
        page += 1


def pdf_url(uploaded_file):
    return FILE + urllib.parse.quote("/" + uploaded_file)   # leading slash required


def fetch(rec, out, lang="ENGLISH"):
    """Download one act's PDF. Returns the manifest record, path set if fetched."""
    c = next((c for c in rec.get("contents", []) if c.get("language") == lang), None)
    m = {"act_no": rec.get("actNoText"), "date": rec.get("date"),
         "description": rec.get("descriptionEnglish"), "lang": lang,
         "source_url": pdf_url(c["uploadedFile"]) if c else None, "path": None}
    if not c:
        return m
    path = os.path.join(out, f"{str(rec.get('actNoText', 'x')).replace('/', '-')}.pdf")
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        m["path"] = path                                    # resume: already have it
        return m
    blob = _get(m["source_url"])
    if not blob.startswith(b"%PDF"):
        m["error"] = blob[:120].decode("utf8", "replace")
        return m
    with open(path, "wb") as f:
        f.write(blob)
    m["path"], m["bytes"] = path, len(blob)
    return m


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--out", default="corpus")
    a.add_argument("--search")
    a.add_argument("--lang", default="ENGLISH", choices=["ENGLISH", "SINHALA", "TAMIL"])
    a.add_argument("--limit", type=int, default=100,
                   help="page size; widened automatically unless --pages is set")
    a.add_argument("--pages", type=int, help="stop after N pages")
    a.add_argument("--list", action="store_true", help="list only, do not download")
    args = a.parse_args()

    man, got, miss = None, 0, 0
    if not args.list:
        os.makedirs(args.out, exist_ok=True)
        man = open(os.path.join(args.out, "manifest.jsonl"), "a")
    for rec in crawl(args.search, args.limit, args.pages):
        if args.list:
            print(f"{rec.get('actNoText'):>10}  {(rec.get('descriptionEnglish') or '')[:70]}")
            continue
        m = fetch(rec, args.out, args.lang)
        man.write(json.dumps(m) + "\n"); man.flush()
        got, miss = got + bool(m["path"]), miss + (not m["path"])
        print(f"{m['act_no']:>10}  {'ok' if m['path'] else m.get('error', 'no ' + args.lang)[:60]}",
              flush=True)
    if man:
        print(f"\n{got} downloaded, {miss} without a {args.lang} PDF -> {args.out}/manifest.jsonl")


if __name__ == "__main__":
    main()
