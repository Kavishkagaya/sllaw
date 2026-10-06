#!/usr/bin/env python3
"""Legislative Enactments 1980 Revised Edition spider: lankalaw.net's chapter list.

  python3 -m etl.spiders.le1980      # print the list

The last official consolidation of pre-1980 law, one PDF per chapter ("Penal Code (Chapter 25)").
These are the laws later Acts cite as "Chapter N", graph node cap:N. One HTML page lists them all:
<tr><td>25</td><td><a href=".../pc25130.pdf">Penal Code (Chapter 25)</a></td></tr>. 519 rows had
a PDF on 2026-10-04, 516 distinct PDFs (chapter numbers run to 636). PDFs download without a login; robots.txt allows.
"""
import html, re

from etl.spiders.acts import _get

PAGE = "https://www.lankalaw.net/legislative-enactments/ceylon-legislative-enactments-1980/"


def crawl():
    page = _get(PAGE).decode("utf8", "replace")
    out = {}
    for num, url, title in re.findall(r'<tr[^>]*>\s*<td>\s*(\d+[A-Z]?)\s*</td>\s*<td>\s*<a\s+href="([^"]+\.pdf)"[^>]*>(.*?)</a>',
                                      page, re.S | re.I):
        title = html.unescape(re.sub(r"<[^>]+>", "", title)).strip()
        out.setdefault(url, {"cap": num, "title": title, "url": url})   # one row per PDF
    return list(out.values())


if __name__ == "__main__":
    rows = crawl()
    for r in rows[:5]:
        print(r)
    print(len(rows), "chapters with a PDF")
