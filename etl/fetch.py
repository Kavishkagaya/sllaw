#!/usr/bin/env python3
"""Fetch step: list a source, archive every file once in R2, record it in Neon.

  python3 -m etl.fetch acts                 # discover + fetch everything new
  python3 -m etl.fetch acts --limit 20      # pilot
  python3 -m etl.fetch acts --no-discover   # only drain the fetch queue
  python3 -m etl.fetch le1980               # Legislative Enactments 1980 (lankalaw.net), one row per chapter
  python3 -m etl.fetch le1956               # Legislative Enactments 1956 (lankalaw.net), HTML, one row per chapter
  python3 -m etl.fetch lankalaw             # lankalaw.net Acts by year, only those filling a gap
  python3 -m etl.fetch parliament           # parliament.lk official PDFs, 1956 on, not already from documents.gov.lk
  python3 -m etl.fetch constitution         # parliament.lk: the 1978 Constitution and its consolidations
  python3 -m etl.fetch gazette              # documents.gov.lk extraordinary gazettes 2010-: the law in them only

One documents row per file (an act in three languages = three rows). Files are
keyed by content hash, source/<sha256>.pdf, so re-runs and duplicates never
write twice and nothing is overwritten. The queue is `r2_key IS NULL`: a crash
or a failed download just means run it again.
"""
import argparse, hashlib, os, re, time
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json, execute_values

from etl.spiders import acts, gazettes, lankalaw, le1956, le1980, parliament

load_dotenv()
WORKERS = 8   # parallel downloads; documents.gov.lk is a small govt server, don't go much higher
BATCH = 50    # results per Neon write


def pg_connect(tries=30, wait=10, url=None):
    """psycopg2.connect, retried on connection errors (ada's DNS failed to resolve Neon's host for a minute or so
    three times on 2026-10-10; the first time it killed all four OCR workers at start)."""
    for i in range(tries):
        try:
            return psycopg2.connect(url or os.environ["DATABASE_URL"], connect_timeout=30)
        except psycopg2.OperationalError as e:
            if i == tries - 1:
                raise
            print(f"database not reachable ({str(e).strip()[:80]}), retry in {wait}s", flush=True)
            time.sleep(wait)


def discover_acts(db):
    """Upsert one row per (act, language) file. The listing record is kept
    verbatim in meta so nothing from the source is lost."""
    # one batched statement: row-by-row inserts cost a Neon round trip each (minutes from ada).
    # dict dedupes by URL: one VALUES list can't upsert the same key twice.
    rows = {acts.pdf_url(c["uploadedFile"]): (
                "acts", acts.pdf_url(c["uploadedFile"]), rec.get("descriptionEnglish"), rec.get("date"),
                Json({"act_no": rec.get("actNoText"), "lang": c["language"], "listing": rec}))
            for rec in acts.crawl() for c in rec.get("contents") or []
            if c["language"] != "TAMIL"}   # Tamil out of scope (user, 2026-10-06)
    cur = db()                        # connect only now: Neon drops a connection idle through a crawl
    execute_values(cur,
        """INSERT INTO documents (source, source_url, title, doc_date, meta) VALUES %s
           ON CONFLICT (source, source_url) DO UPDATE
           SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""",
        list(rows.values()), page_size=1000)
    return len(rows)


def discover_le1980(db):
    """One row per chapter PDF; meta.cap is the chapter number (graph node cap:N)."""
    rows = [("le1980", r["url"], r["title"], None,
             Json({"cap": r["cap"], "lang": "ENGLISH", "listing": r})) for r in le1980.crawl()]
    cur = db()                        # connect only now: Neon drops a connection idle through a crawl
    execute_values(cur,
        """INSERT INTO documents (source, source_url, title, doc_date, meta) VALUES %s
           ON CONFLICT (source, source_url) DO UPDATE
           SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""", rows, page_size=1000)
    return len(rows)


def discover_le1956(db):
    """Legislative Enactments 1956 Revised Edition (lankalaw.net), one HTML page per chapter: 481 on 2026-10-09."""
    rows = [("le1956", r["url"], r["title"], None,
             Json({"cap1956": r["cap"], "lang": "ENGLISH", "format": "html", "listing": r})) for r in le1956.crawl()]
    cur = db()                        # connect only now: Neon drops a connection idle through a crawl
    execute_values(cur,
        """INSERT INTO documents (source, source_url, title, doc_date, meta) VALUES %s
           ON CONFLICT (source, source_url) DO UPDATE
           SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""", rows, page_size=1000)
    return len(rows)


def discover_lankalaw(db):
    """lankalaw.net rows only for Acts with no English file from documents.gov.lk (listed without
    English, or not listed at all), 1956 onwards: 731 files from 1980 on 2026-10-05 (573 PDF, 158 HTML),
    612 before 1980 on 2026-10-09 (593 HTML, 19 PDF). Same act_no, so the same
    graph node. doc_date is the year's 1 January until the Act's own "[Certified on ...]" is read."""
    # 71 year pages take minutes, and Neon closes an idle connection (2026-10-09; parliament.lk's 467 pages, 2026-10-10)
    listed = lankalaw.crawl(range(1956, 2027))
    cur = db()                        # connect only now: Neon drops a connection idle through a crawl
    cur.execute("SELECT DISTINCT meta->>'act_no' FROM documents WHERE source = 'acts' AND meta->>'lang' = 'ENGLISH'")
    have = {r[0] for r in cur.fetchall()}
    # nor what parliament.lk's official files cover (their unused lankalaw rows were deleted 2026-10-10, user);
    # lankalaw lists one file per number: the Law in 1973-77, else the Act
    cur.execute("""SELECT meta->>'kind', meta->>'act_no' FROM documents WHERE source = 'parliament' AND raw_key IS NOT NULL
                   AND NOT meta ? 'wrong_file'""")
    official = set(cur.fetchall())
    kind = lambda no: "law" if 1973 <= int(no[-4:]) <= 1977 else "act"
    rows = [("lankalaw", r["url"], r["title"], f"{r['act_no'].split('/')[1]}-01-01",
             Json({"act_no": r["act_no"], "lang": "ENGLISH", "format": r["format"], "date_precision": "year",
                   "listing": r}))
            # 1956 onwards (2026-10-09; 1980 onwards from 2026-10-05): pre-1980 Acts and 1972-77 Laws are
            # almost all HTML there, and are what most unresolved amendment edges point at (SOURCES.md)
            for r in listed if r["act_no"] not in have and (kind(r["act_no"]), r["act_no"]) not in official
            and not r["url"].endswith(("_S.pdf", "_T.pdf"))   # documents.gov.lk Sinhala/Tamil, listed as English
            and 1956 <= int(r["act_no"].split("/")[1]) <= 2026]
    execute_values(cur,
        """INSERT INTO documents (source, source_url, title, doc_date, meta) VALUES %s
           ON CONFLICT (source, source_url) DO UPDATE
           SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""", rows, page_size=1000)
    return len(rows)


def discover_parliament(db):
    """parliament.lk official English PDFs, 1956 onwards (user, 2026-10-10), for Acts and 1972-78 Laws with no
    documents.gov.lk English file: 1,147 on 2026-10-10 (244 we held no file for, 553 byte-identical to
    lankalaw's PDFs, 349 replacing lankalaw HTML). A CommonLII copy doesn't count as held (user, 2026-10-10):
    it is retyped 2007 text, kept only for laws no official source has; build prefers this file over it. meta.kind 'law' for the
    "(L)" rows, so graph.act_key gives law:N/YYYY. graph.build prefers these rows over lankalaw's."""
    listed = parliament.crawl()
    cur = db()                        # connect only now: Neon drops a connection idle through a crawl
    cur.execute("SELECT DISTINCT meta->>'act_no' FROM documents WHERE source = 'acts' AND meta->>'lang' = 'ENGLISH'")
    have = {("act", r[0]) for r in cur.fetchall()}
    # one spelling on both sides: parliament.lk lists "05/1972", our rows "5/1972"
    norm = lambda k, n: (k, f"{int(n.split('/')[0])}/{n.split('/')[1]}") if n and re.fullmatch(r"\d+/\d{4}", n) else (k, n)
    have = {norm(*h) for h in have}
    rows = [("parliament", r["url"], r["title"], r["date"],
             Json({"act_no": r["act_no"], "kind": r["kind"], "lang": "ENGLISH", "listing": r}))
            for r in listed if int(r["act_no"][-4:]) >= 1956 and (r["kind"], r["act_no"]) not in have]
    execute_values(cur,
        """INSERT INTO documents (source, source_url, title, doc_date, meta) VALUES %s
           ON CONFLICT (source, source_url) DO UPDATE
           SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""", rows, page_size=1000)
    return len(rows)


# parliament.lk /en/constitution/<slug> (SOURCES.md, 2026-10-11): the 1978 text and the text as amended up to the
# Nth amendment. /files/pdf/constitution.pdf is the up-to-21st file again; no consolidation up to the 22nd yet.
# ponytail: six fixed files, no spider; re-check the pages when a 23rd amendment passes
CONSTITUTION = [("constitution", "1978ConstitutionWithoutAmendments.pdf", "1978-09-07",
                 "Constitution of the Democratic Socialist Republic of Sri Lanka (1978, as enacted)")] + [
    (f"constitution:{n}", f"constitution-upto-{n}th.pdf" if n < 21 else "constitution-upto-21st.pdf", None,
     f"Constitution of the Democratic Socialist Republic of Sri Lanka (as amended up to the {o} Amendment)")
    for n, o in [(17, "Seventeenth"), (18, "Eighteenth"), (19, "Nineteenth"), (20, "Twentieth"), (21, "Twenty First")]]


def discover_constitution(db):
    """meta.constitution is the key: `constitution` (1978 text), `constitution:N` (as amended up to the Nth)."""
    base = "https://www.parliament.lk/files/pdf/constitution/"
    rows = [("constitution", base + f, title, date, Json({"constitution": key, "lang": "ENGLISH", "listing": {"title": title},
                  **({"spread": True} if key == "constitution" else {})}))     # two printed pages per image
            for key, f, date, title in CONSTITUTION]
    cur = db()
    execute_values(cur,
        """INSERT INTO documents (source, source_url, title, doc_date, meta) VALUES %s
           ON CONFLICT (source, source_url) DO UPDATE
           SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""", rows)
    return len(rows)


def discover_gazettes(db):
    """One row per law gazette's English PDF (etl/spiders/gazettes.py: regulations, orders, rules, by-laws, levies;
    not land acquisition, elections, appointments). meta.gazette_no is the key: gazette:<no> ("2235/22")."""
    rows = {acts.pdf_url(c["uploadedFile"]): (
                "gazette", acts.pdf_url(c["uploadedFile"]), rec.get("descriptionEnglish"), rec.get("date"),
                Json({"gazette_no": rec.get("gazetteNoText"), "lang": "ENGLISH", "listing": rec}))
            for rec in gazettes.crawl() if gazettes.is_law(rec.get("descriptionEnglish"))
            for c in rec.get("contents") or [] if c["language"] == "ENGLISH"}   # English only (scope, 2026-10-10)
    cur = db()
    execute_values(cur,
        """INSERT INTO documents (source, source_url, title, doc_date, meta) VALUES %s
           ON CONFLICT (source, source_url) DO UPDATE
           SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""", list(rows.values()), page_size=1000)
    return len(rows)


def r2():
    return boto3.client(
        "s3", region_name="auto",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"])


def download(s3, bucket, stored, did, url):
    """One file: download, hash, put to R2 unless already stored. Runs in a worker thread."""
    try:
        try:
            blob = acts._get(url)
        except (Exception, SystemExit):   # dead host, expired cert, 404: closest raw Wayback snapshot
            blob = acts._get(f"https://web.archive.org/web/2id_/{url}")
        html = url.lower().endswith((".html", ".htm"))    # lankalaw serves some Acts as HTML pages
        if html and b"<" not in blob[:2000]:
            raise ValueError("not HTML: " + blob[:80].decode("utf8", "replace"))
        if not html and not blob.startswith(b"%PDF"):
            raise ValueError("not a PDF: " + blob[:80].decode("utf8", "replace"))
        sha = hashlib.sha256(blob).hexdigest()
        key = f"source/{sha}.{'html' if html else 'pdf'}"
        # two workers racing on the same sha both put the same bytes to the same key: harmless
        if sha not in stored:
            s3.put_object(Bucket=bucket, Key=key, Body=blob, ContentType="text/html" if html else "application/pdf")
            stored.add(sha)
        return did, sha, key, len(blob), None
    except (Exception, SystemExit) as e:   # acts._get raises SystemExit on HTTP errors
        return did, None, None, None, f"fetch: {e}"[:500]


def save(cur, results):
    ok = [r[:4] for r in results if not r[4]]
    bad = [(r[0], r[4]) for r in results if r[4]]
    if ok:
        execute_values(cur, """UPDATE documents d SET sha256=v.sha, r2_key=v.key, bytes=v.n,
            fetched_at=NOW(), error=NULL, updated_at=NOW()
            FROM (VALUES %s) AS v(id, sha, key, n) WHERE d.id = v.id""", ok)
        # a file another source already gave us (parliament.lk PDFs lankalaw re-hosts): reuse its raw
        cur.execute("""UPDATE documents d SET raw_key = o.raw_key, extracted_at = o.extracted_at, updated_at = NOW()
            FROM documents o WHERE d.id = ANY(%s) AND d.raw_key IS NULL
            AND o.sha256 = d.sha256 AND o.raw_key IS NOT NULL""", ([r[0] for r in ok],))
    if bad:
        execute_values(cur, """UPDATE documents d SET error=v.err, updated_at=NOW()
            FROM (VALUES %s) AS v(id, err) WHERE d.id = v.id""", bad)


def fetch(conn, source, limit=None):
    s3, bucket, cur = r2(), os.environ["R2_BUCKET"], conn.cursor()
    # hashes already in R2, loaded once: Neon round trips from ada cost more than the downloads
    cur.execute("SELECT DISTINCT sha256 FROM documents WHERE r2_key IS NOT NULL")
    stored = {r[0] for r in cur.fetchall()}
    # Sinhala rows are kept as listing records but not fetched (user, 2026-10-10)
    cur.execute("SELECT id, source_url FROM documents WHERE source = %s AND r2_key IS NULL "
                "AND meta->>'lang' = 'ENGLISH' ORDER BY id LIMIT %s", (source, limit))
    rows, ok, bad, done = cur.fetchall(), 0, 0, []
    with ThreadPoolExecutor(WORKERS) as pool:
        for n, r in enumerate(as_completed([pool.submit(download, s3, bucket, stored, *row)
                                            for row in rows]), 1):
            did, _, _, size, err = r.result()
            done.append(r.result())
            ok, bad = ok + (not err), bad + bool(err)
            print(f"[{n}/{len(rows)}] doc {did}: {f'FAIL {err}'[:100] if err else f'ok {size // 1024} KB'}",
                  flush=True)
            if len(done) >= BATCH or n == len(rows):
                save(cur, done)
                conn.commit()
                done = []
    print(f"\n{ok} fetched, {bad} failed (failed rows stay queued; re-run to retry)")


def main():
    a = argparse.ArgumentParser()
    a.add_argument("source", choices=["acts", "le1956", "le1980", "lankalaw", "parliament", "constitution", "gazette"])
    a.add_argument("--limit", type=int, help="fetch at most N files (pilot)")
    a.add_argument("--no-discover", action="store_true", help="skip listing, only drain the queue")
    args = a.parse_args()

    conn = None

    def db():     # opened on first use, after the source's listing is crawled
        nonlocal conn
        for i in range(5):    # ada's DNS fails now and then (2026-10-10): don't lose a 10-minute crawl to it
            try:
                conn = conn or psycopg2.connect(os.environ["DATABASE_URL"])
                break
            except psycopg2.OperationalError:
                if i == 4:
                    raise
                time.sleep(30)
        return conn.cursor()

    if not args.no_discover:
        discover = {"acts": discover_acts, "le1956": discover_le1956, "le1980": discover_le1980,
                    "lankalaw": discover_lankalaw, "parliament": discover_parliament,
                    "constitution": discover_constitution, "gazette": discover_gazettes}[args.source]
        print(f"discovered {discover(db)} files")
        conn.commit()
    db()
    fetch(conn, args.source, args.limit)
    conn.close()


if __name__ == "__main__":
    main()
