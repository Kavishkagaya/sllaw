#!/usr/bin/env python3
"""Legislative Enactments 1956 Revised Edition spider: lankalaw.net's chapter list.

  python3 -m etl.spiders.le1956      # print the list

The 1956 consolidation, one HTML page per chapter: <a href=".../1956Y3V75C.html">ABOLITION OF SLAVERY</a>
(Volume 3, Chapter 75). Its chapter numbers are what Acts before the 1980 Revised Edition, and some
after, cite as "Chapter 203" (= Motor Traffic here; Agricultural Products in 1980): graph node
cap1956:N. 481 chapters on 2026-10-09, all HTML, same note | section table rows as lankalaw's Acts.
"""
import html, re

from etl.spiders.acts import _get

PAGE = "https://www.lankalaw.net/legislative-enactments/ceylon-legislative-enactments-1956/"


def crawl():
    page = _get(PAGE).decode("utf8", "replace")
    out = {}
    for m in re.finditer(r'href="([^"]+/1956Y(\d+)V(\d+[A-Z]?)C\.html?)"[^>]*>(.*?)</a>', page, re.S | re.I):
        out.setdefault(m[1], {"cap": m[3], "volume": int(m[2]), "url": m[1],
                              "title": html.unescape(re.sub(r"<[^>]+>", "", m[4])).strip()})
    return list(out.values())


if __name__ == "__main__":
    rows = crawl()
    for r in rows[:5]:
        print(r)
    print(len(rows), "chapters")
