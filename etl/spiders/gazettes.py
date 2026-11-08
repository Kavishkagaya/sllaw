#!/usr/bin/env python3
"""Extraordinary gazettes spider: documents.gov.lk listing (2010-), the law in it only (issue #6).

  python3 etl/spiders/gazettes.py            # count law gazettes by year

Same Server Action as the Acts listing (`TableDataAction`), page /web/extra_gazettes. Kept: regulations, rules,
orders, by-laws, levy/duty/tax orders, emergency regulations and anything made under a section of an Act; dropped:
land acquisition and title settlement, elections, appointments, weekly exchange rates (74% of the listing; survey
and decision 2026-10-20, SOURCES.md). The test is on the English description ("Department - subject").
"""
import re, sys

from etl.spiders import acts

PAGE = "https://documents.gov.lk/web/extra_gazettes"
LAW = re.compile(r"\bregulations?\b|\brules\b|by[- ]?laws?|\border\b|\bduty\b|\blevy\b|\btax\b|tariff|emergency|"
                 r"public security|made under|under section", re.I)
NOISE = re.compile(r"land\s*acqu?isition|title settlement|land title|cad\.? map|election|elected|member of|\bappoint|"
                   r"rates? of exchange|acquire", re.I)


def is_law(description):
    d = description or ""
    return bool(LAW.search(d)) and not NOISE.search(d)


def discover():
    """The Server Action id and endpoint are build-specific: read them from the page each run."""
    html = acts._get(PAGE).decode("utf8", "replace")
    ep = re.search(r'apiEndpoint\\?":\\?"([^"\\]+extra-gazette/get-all)', html)
    for chunk in dict.fromkeys(re.findall(r'/_next/static/chunks/[\w/-]+\.js', html)):
        js = acts._get("https://documents.gov.lk" + chunk).decode("utf8", "replace")
        if (m := re.search(r'createServerReference\)?\("([0-9a-f]{20,})"[^)]*?"TableDataAction"\)', js)):
            return m[1], ep[1]
    raise SystemExit("could not find TableDataAction: the site layout changed")


def _page(action, endpoint, page, limit):
    """A page past a few thousand rows can fail on RSC `T` rows (long strings split out): ask for the same rows as
    four smaller pages instead."""
    acts.PAGE = PAGE
    try:
        return acts.search(action, endpoint, page=page, limit=limit).get("data") or []
    except SystemExit:
        if limit <= 25:
            print(f"page {page} of {limit} unreadable, skipped", file=sys.stderr)
            return []
        return [it for k in range(4) for it in _page(action, endpoint, (page - 1) * 4 + k + 1, limit // 4)]


def by_number(action, endpoint, n, limit=500):
    """Every record of gazette number n (2513 -> 2513/01, 2513/02, ...): the free-text search matches the number,
    and one number is a week (6-60 records), so it fits one page and the shifting order cannot drop any. The search
    also returns other numbers that mention n in their text; they are kept too (deduped by id)."""
    page, out = 1, []
    while True:
        for i in range(3):
            try:
                rows = acts.search(action, endpoint, q=f"{n}/", page=page, limit=limit).get("data") or []
                break
            except (SystemExit, Exception) as e:   # acts.search exits on an odd reply; one number must not stop all
                if i == 2:
                    print(f"number {n} unreadable, skipped: {str(e)[:100]}", file=sys.stderr, flush=True)
                    return out
        out += rows
        if len(rows) < limit:
            return out
        page += 1


def crawl(limit=1000, threads=4):
    """Every record, deduped by id. The site's order shifts between pages and the site sends no sort (its own
    page neither; 2026-11-08), so paging drops ~2% (4 passes saw 38,591 of 39,323, 2026-11-07). So: one pass of
    pages for the range of gazette numbers, then each number on its own (checked 2026-11-08: for 2508-2512 the
    search found exactly the records the listing has, none missing, none extra)."""
    from concurrent.futures import ThreadPoolExecutor
    action, endpoint = discover()
    acts.PAGE = PAGE
    total = int(acts.search(action, endpoint, page=1, limit=5)["pagination"]["total"])
    seen = {}
    for page in range(1, total // limit + 2):
        for it in _page(action, endpoint, page, limit):
            seen.setdefault(it["id"], it)
    paged = len(seen)
    nums = [r["gazetteNo"] for r in seen.values() if isinstance(r.get("gazetteNo"), int)]
    with ThreadPoolExecutor(threads) as ex:
        for rows in ex.map(lambda n: by_number(action, endpoint, n), range(min(nums), max(nums) + 1)):
            for it in rows:
                seen.setdefault(it["id"], it)
    print(f"{len(seen)} of {total} listed ({paged} by pages, then numbers {min(nums)}-{max(nums)} one by one)",
          file=sys.stderr, flush=True)
    return list(seen.values())


if __name__ == "__main__":
    from collections import Counter
    recs = [r for r in crawl() if is_law(r.get("descriptionEnglish"))]
    print(len(recs), "law gazettes;", sorted(Counter(r["date"][:4] for r in recs).items()))
