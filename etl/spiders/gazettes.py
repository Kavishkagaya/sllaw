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


def crawl(limit=1000, passes=4):
    """Every record, deduped by id. The upstream ordering shifts between pages (one pass got 38,500 of 39,107,
    2026-10-20), so pass again until a pass adds nothing new."""
    action, endpoint = discover()
    acts.PAGE = PAGE
    total = int(acts.search(action, endpoint, page=1, limit=5)["pagination"]["total"])
    seen = {}
    for p in range(passes):
        before = len(seen)
        for page in range(1, total // limit + 2):
            for it in _page(action, endpoint, page, limit):
                seen.setdefault(it["id"], it)
        print(f"pass {p + 1}: {len(seen)} of {total} listed", file=sys.stderr, flush=True)
        if len(seen) >= total or len(seen) == before:
            break
    return list(seen.values())


if __name__ == "__main__":
    from collections import Counter
    recs = [r for r in crawl() if is_law(r.get("descriptionEnglish"))]
    print(len(recs), "law gazettes;", sorted(Counter(r["date"][:4] for r in recs).items()))
