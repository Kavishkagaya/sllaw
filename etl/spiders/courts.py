#!/usr/bin/env python3
"""Court judgment spiders (court-judgments brief, #63; SOURCES.md "Courts", 2026-11-16). Judgments decided from
FROM_YEAR on (user, 2026-11-16).

  python3 -m etl.spiders.courts 2024             # print counts for one Court of Appeal year

Court of Appeal: courtofappeal.lk/judgments?year=YYYY (the decided year), the whole year on one page; each row's
button carries every field as data- attributes (data-case, data-date, data-by, data-parties, data-keywords,
data-legislation, data-file = "uploads/judgments/<name>.pdf"). Open, no challenge.

Supreme Court: supremecourt.lk/judgements/ is one table (Date with data-order="YYYY-MM-DD", Case No, Parties
(short-text + full-text spans), Judges & Judgments = one line per judge with its own PDF, hidden Keywords and
Legislation). The live site is behind a Cloudflare challenge (its spider: d3). Judgments to 2026-08-07 came in
once from Wayback and a mirror (etl/v2/backfill.py), never part of the pipeline (user, 2026-11-16).

A document is one PDF: key `ca:<file name>` / `sc:<file name>` (lower case, no .pdf), the court's own file name,
so every copy of a file lands on one key.
"""
import html, os, re, sys

from etl.spiders.acts import _get

FROM_YEAR = 2021
SEEN = {}          # the last crawl's {year: (rows on the page, rows with a PDF)}, for the run's report
CA_PAGE = "https://courtofappeal.lk/judgments?year={}"
CA_BASE = "https://courtofappeal.lk/"
SC_LIVE = "https://supremecourt.lk/judgements/"


def key(court, url):
    """'sc', '.../sc_appeal_133_2018.pdf' -> 'sc:sc_appeal_133_2018'."""
    return f"{court}:{os.path.basename(url.split('?')[0])[:-4].lower()}"


def _text(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def ca_rows(page):
    """One year page -> (rows with a PDF, rows on the page)."""
    trs = re.findall(r"<tr>\s*<td>\d{4}-\d\d-\d\d</td>.*?</tr>", page, re.S)
    out = []
    for tr in trs:
        a = dict(re.findall(r'data-(case|date|by|parties|keywords|legislation|file)="([^"]*)"', tr))
        a = {k: html.unescape(v).strip() for k, v in a.items()}
        if not a.get("file", "").lower().endswith(".pdf"):
            continue
        out.append({"court": "ca", "url": CA_BASE + a["file"].lstrip("/"), "case": a.get("case"), "date": a.get("date"),
                    "judge": a.get("by"), "parties": a.get("parties"), "keywords": a.get("keywords"),
                    "legislation": a.get("legislation")})
    return out, len(trs)


def ca_crawl(years):
    """-> (rows, {year: (rows on the page, rows with a PDF)})."""
    rows, counts = [], {}
    for y in years:
        got, n = ca_rows(_get(CA_PAGE.format(y)).decode("utf8", "replace"))
        rows += got
        counts[y] = (n, len(got))
    return rows, counts


def sc_rows(page):
    """The Supreme Court table (live or archived) -> one row per PDF (a judge line with a Download link)."""
    out = []
    for tr in re.findall(r"<tr>\s*<td data-order=\"\d{4}-\d\d-\d\d\".*?</tr>", page, re.S):
        d = re.search(r'data-order="(\d{4}-\d\d-\d\d)"', tr)[1]
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        case = _text(tds[1]) if len(tds) > 1 else None
        full = re.search(r'<span class="full-text">(.*?)</span>', tr, re.S)
        parties = _text(full[1] if full else (tds[2] if len(tds) > 2 else ""))
        hidden = [_text(t) for t in tds[4:6]] + [None, None]
        for line in re.findall(r'<div class="jm-fe-judge-line">(.*?)</div>', tr, re.S):
            pdf = re.search(r'href="([^"]+\.pdf)"', line, re.I)
            if not pdf:
                continue
            url = re.sub(r"^https?://(web\.archive\.org/web/\w+/)?(https?://)?(www\.)?", "https://", pdf[1])
            judge = _text(re.search(r'jm-fe-judge-badge">(.*?)</span>', line, re.S)[1]).lstrip("⚖ ").strip()
            out.append({"court": "sc", "url": url, "case": case, "date": d, "judge": judge, "parties": parties,
                        "keywords": hidden[0] or None, "legislation": hidden[1] or None})
    return out


def recent(rows):
    return [r for r in rows if r["date"] and int(r["date"][:4]) >= FROM_YEAR]


if __name__ == "__main__":
    from collections import Counter
    rows, counts = ca_crawl([int(y) for y in sys.argv[2:]])
    print(counts)
    print(len(rows), "PDFs;", sorted(Counter(r["date"][:4] for r in rows).items()))
    print(rows[0])
