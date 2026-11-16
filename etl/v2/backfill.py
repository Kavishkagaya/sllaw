"""One-time backfill of court judgments decided from 2021 (court-judgments #63; user, 2026-11-16: "the later runner
doesn't need to think about GitHub, Wayback etc. It will just fetch the real site").

The pipeline lists and fetches judgments from the courts' own sites only. Run by hand once, this fills in what those
sites cannot give in bulk: supremecourt.lk is behind a Cloudflare challenge, so its listing to 2026-08-07 comes from
Wayback's capture of it and its PDFs from the nuuuwan mirror, else Wayback (paced). Everything is recorded against the
court's own listing row (source supremecourt.lk, source_url = the court's file), with `fetched_from` saying where the
bytes really came from; no mirror or Wayback row is left for the pipeline to rank.

  python3 -m etl.v2.backfill list                 # the court's SC listing as Wayback archived it + mirror-only rows
  python3 -m etl.v2.backfill migrate              # files fetched through the mirror's own listing rows (the samples,
                                                  # before this script) onto the court's rows; the mirror's rows dropped
  python3 -m etl.v2.backfill fetch [--workers 4]  # every judgment from 2021 with no file: CA from its site, SC from
                                                  # the mirror, else Wayback; a key no copy has gets its error recorded
Env: V2_DATABASE_URL, R2 (as the pipeline). SOURCES.md "Courts" has the counts (2026-11-16).
"""
import argparse, csv, hashlib, io, os, re
from concurrent.futures import ThreadPoolExecutor, as_completed

from etl.spiders import courts
from etl.spiders.acts import _get

SC_WAYBACK = "https://web.archive.org/web/20260820033143id_/https://supremecourt.lk/judgements/"
MIRROR = "https://raw.githubusercontent.com/nuuuwan/lk_supreme_court_judgements/data/data/lk_supreme_court_judgements/"


def sc_wayback():
    """The court's whole SC table as Wayback captured it on 2026-08-20 (to 2026-08-07)."""
    return courts.sc_rows(_get(SC_WAYBACK).decode("utf8", "replace"))


def mirror_rows():
    """The mirror's index -> rows with the court's file as `url` and the mirror's copy as `mirror`."""
    t = _get(MIRROR + "docs_all.tsv").decode("utf8", "replace")
    csv.field_size_limit(10 ** 8)
    out = []
    for r in csv.DictReader(io.StringIO(t), delimiter="\t"):
        url, d = r["url_pdf"].strip().replace("http://", "https://"), r["date_str"][:10]
        if not url.lower().endswith(".pdf") or not re.fullmatch(r"\d{4}-\d\d-\d\d", d):
            continue
        out.append({"court": "sc", "url": url, "mirror": f"{MIRROR}{d[:3]}0s/{d[:4]}/{r['doc_id']}/doc.pdf",
                    "case": r["num"], "date": d, "judge": (r["judgement_by"] or "").strip(" ⚖") or None,
                    "parties": (r["parties"] or "").strip() or None, "keywords": None, "legislation": None,
                    "via": "nuuuwan mirror"})
    return out


def db():
    from etl.fetch import pg_connect
    return pg_connect(url=os.environ["V2_DATABASE_URL"])


def list_sc():
    """The court's listing (Wayback) and, for files it does not list, the mirror's rows, as supremecourt.lk rows."""
    from etl.v2 import stages
    listed = courts.recent(sc_wayback())
    seen = {r["url"] for r in listed}
    extra = [{k: v for k, v in r.items() if k != "mirror"} for r in courts.recent(mirror_rows()) if r["url"] not in seen]
    print("court listing", len(listed), "mirror-only", len(extra))
    print(stages.write_rows(db, "supremecourt.lk/backfill", [stages._court(r) for r in listed + extra]))


def migrate():
    """Move files fetched through 'lk_datasets' rows onto the court's row for the same file; drop those rows."""
    c = db()
    with c, c.cursor() as cur:
        cur.execute("""SELECT m.id, c.id FROM listings m JOIN listings c ON c.source = 'supremecourt.lk'
                         AND c.source_url = m.listing->'v1_meta'->'listing'->>'court_url' WHERE m.source = 'lk_datasets'""")
        pairs = cur.fetchall()
        moved = 0
        for mid, cid in pairs:
            cur.execute("SELECT sha256 FROM listing_files WHERE listing_id = %s", (mid,))
            got = cur.fetchone()
            if got and got[0]:
                cur.execute("DELETE FROM listing_files WHERE listing_id = %s", (cid,))
                cur.execute("UPDATE listing_files SET listing_id = %s WHERE listing_id = %s", (cid, mid))
                moved += 1
            cur.execute("UPDATE documents SET listing_id = %s WHERE listing_id = %s", (cid, mid))
        cur.execute("SELECT count(*) FROM listings WHERE source = 'lk_datasets'")
        n = cur.fetchone()[0]
        cur.execute("DELETE FROM listing_files WHERE listing_id IN (SELECT id FROM listings WHERE source = 'lk_datasets')")
        cur.execute("DELETE FROM documents WHERE listing_id IN (SELECT id FROM listings WHERE source = 'lk_datasets')")
        cur.execute("DELETE FROM listings WHERE source = 'lk_datasets'")
        cur.execute("DELETE FROM work WHERE stage = 'fetch' AND item LIKE '%%raw.githubusercontent.com%%'")
    print(f"paired {len(pairs)}, files moved {moved}, mirror rows dropped {n}")


def todo(c):
    """[(listing id, court, court url)] for every judgment key from 2021 with no file yet (one row per key)."""
    with c.cursor() as cur:
        cur.execute("""SELECT DISTINCT ON (l.listed_key) l.id, split_part(l.listed_key, ':', 1), l.source_url FROM listings l
                       WHERE l.type LIKE '%%judgment' AND l.date >= '2021' AND l.listed_key NOT IN (
                         SELECT l2.listed_key FROM listings l2 JOIN listing_files lf ON lf.listing_id = l2.id
                         WHERE lf.sha256 IS NOT NULL AND l2.listed_key IS NOT NULL)
                       ORDER BY l.listed_key, l.id""")
        rows = cur.fetchall()
    c.commit()
    return rows


def put(blob):
    """Bytes -> (sha, R2 key, size), stored once per sha256 (as etl.fetch.download)."""
    from etl.v2 import build as B
    if not blob.startswith(b"%PDF"):
        raise ValueError("not a PDF: " + blob[:80].decode("utf8", "replace"))
    sha = hashlib.sha256(blob).hexdigest()
    key = f"source/{sha}.pdf"
    s3, bucket = B.r2()
    s3.put_object(Bucket=bucket, Key=key, Body=blob, ContentType="application/pdf")
    return sha, key, len(blob)


def one(court, url, mirror):
    """-> (sha, key, size, fetched_from) or raises. CA: its site. SC: the mirror, else Wayback (etl.fetch.wayback,
    paced: one request at a time, back-off on refusals)."""
    from etl.fetch import wayback
    if court == "ca":
        return (*put(_get(url)), url)
    if url in mirror:
        try:
            return (*put(_get(mirror[url], tries=2)), mirror[url])
        except (Exception, SystemExit):
            pass
    return (*put(wayback(url)), f"https://web.archive.org/web/2id_/{url}")


def fetch(workers=4):
    from etl.v2 import stages
    c = db()
    rows = todo(c)
    mirror = {r["url"]: r["mirror"] for r in mirror_rows()} if any(court == "sc" for _, court, _ in rows) else {}
    print(f"{len(rows)} keys to fetch: ca {sum(r[1] == 'ca' for r in rows)}, sc {sum(r[1] == 'sc' for r in rows)}", flush=True)
    ok = bad = 0
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(one, court, url, mirror): (lid, url) for lid, court, url in rows}
        for n, f in enumerate(as_completed(futs), 1):
            lid, url = futs[f]
            try:
                sha, key, size, got = f.result()
                stages.record(c, lid, sha, key, size, got)
                ok += 1
            except (Exception, SystemExit) as e:
                stages.failed(c, lid, f"backfill: {e}"[:500])
                bad += 1
            if n % 100 == 0:
                print(f"{n}/{len(rows)}: ok {ok}, no copy {bad}", flush=True)
    print(f"done: ok {ok}, no copy {bad}", flush=True)


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["list", "migrate", "fetch"])
    a.add_argument("--workers", type=int, default=4)
    x = a.parse_args()
    {"list": list_sc, "migrate": migrate, "fetch": lambda: fetch(x.workers)}[x.cmd]()
