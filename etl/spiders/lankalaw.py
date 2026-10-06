#!/usr/bin/env python3
"""lankalaw.net Acts-by-year spider: fills the gaps documents.gov.lk leaves.

  python3 -m etl.spiders.lankalaw          # print counts per year

One page per year, /sri-lanka-acts-<year>/, a table of rows
  <td>01/1985 :&nbsp;<a href=".../3243.pdf">Employees' Provident Fund (Amendment)</a></td>
linking a PDF or, for some Acts, an HTML page. The number matches documents.gov.lk's act_no, so
each row lands on the same graph node (act:1/1985). Private site; robots.txt allows everything and
the files download without a login (SOURCES.md).
"""
import html, re

from etl.spiders.acts import _get

YEARS = range(1956, 2027)
PAGE = "https://www.lankalaw.net/sri-lanka-acts-{}/"
ROW = re.compile(r'(\d{1,3})\s*/\s*(\d{4})\s*:?\s*(?:&nbsp;|\s)*<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S | re.I)


def crawl(years=YEARS):
    out = {}
    for y in years:
        try:
            page = _get(PAGE.format(y)).decode("utf8", "replace")
        except (Exception, SystemExit) as e:                # a missing year page is not fatal
            print(f"  {y}: {e}"[:120])
            continue
        for num, yr, url, title in ROW.findall(page):
            fmt = url.rsplit(".", 1)[-1].lower()
            if fmt not in ("pdf", "html", "htm"):
                continue
            no = f"{int(num)}/{yr}"
            out.setdefault(url, {"act_no": no, "title": html.unescape(re.sub(r"<[^>]+>", "", title)).strip(),
                                 "url": url, "format": "html" if fmt.startswith("htm") else "pdf", "page_year": y})
    return list(out.values())


if __name__ == "__main__":
    from collections import Counter
    rows = crawl()
    print(len(rows), "files;", dict(Counter(r["format"] for r in rows)))
    print(sorted(Counter(r["act_no"].split("/")[1] for r in rows).items()))
