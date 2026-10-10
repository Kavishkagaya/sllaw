#!/usr/bin/env python3
"""parliament.lk Acts listing spider: the official English PDFs (SOURCES.md, surveyed 2026-10-10).

  python3 -m etl.spiders.parliament          # print counts

/en/business-of-parliament/acts-listing?page=N, server-rendered, 8 rows a page (467 pages, 3,733 rows):
  <a href='.../act-details/G6422'><h1 class='sub_heading'>16/2026 : Prevention of Money ...</h1></a>
  <p class='fst-italic'>Endorsed Date: 2026-08-04</p> ... <a href='.../uploads/acts/gbills/english/6422.pdf'>
1972-78 National State Assembly Laws: "05/1972(L)" in 1972 and 1978; 1973-77 rows carry no "(L)" but had only
Laws, so they are kind 'law' too. The pre-1956 chapters as "Chap N"
(no PDF). Only rows with a PDF are returned.
"""
import html, re, time

from etl.spiders.acts import _get

PAGE = "https://www.parliament.lk/en/business-of-parliament/acts-listing?page={}"
ROW = re.compile(r"act-details/(\w+)'\s*>\s*<h1 class='sub_heading'>(.*?)</h1>.*?Endorsed Date: ([^<]*)</p>"
                 r"(.*?)</div>\s*</div>\s*</div>", re.S)
NUM = re.compile(r"\s*(\d{1,3})\s*/\s*(\d{4})\s*(\(L\))?\s*:\s*(.*)", re.S)


def crawl(pause=0.5):
    first = _get(PAGE.format(1)).decode("utf8", "replace")
    last = max(map(int, re.findall(r"acts-listing\?page=(\d+)", first)))
    out = {}
    for p in range(1, last + 1):
        page = first if p == 1 else _get(PAGE.format(p)).decode("utf8", "replace")
        for gid, head, date, rest in ROW.findall(page):
            pdf = re.search(r"href='(https://www\.parliament\.lk/uploads/acts/[^']+\.pdf)'", rest)
            m = NUM.match(html.unescape(head))
            if pdf and m:   # ponytail: unnumbered rows (Constitution amendments, chapters) skipped; acts holds 0/YYYY
                law = bool(m[3]) or "(L)" in m[4] or 1973 <= int(m[2]) <= 1977   # "Agricultural Productivity(L)"
                out.setdefault(pdf[1], {"act_no": f"{int(m[1])}/{m[2]}", "kind": "law" if law else "act",
                                        "title": m[4].replace("(L)", "").strip(), "date": date.strip(), "id": gid, "url": pdf[1], "page": p})
        time.sleep(pause)
    return list(out.values())


if __name__ == "__main__":
    from collections import Counter
    rows = crawl()
    print(len(rows), "PDFs;", dict(Counter(r["kind"] for r in rows)))
    print(sorted(Counter(int(r["act_no"][-4:]) // 10 * 10 for r in rows).items()))
