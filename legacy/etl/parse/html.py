#!/usr/bin/env python3
"""Consolidated-statute HTML -> breadcrumbed chunks.

lankalaw.net serves the same two-column layout as the printed acts, only as
tables: a `.sectionshorttitle` cell holds the marginal note and the
`.sectioncontent` cell beside it holds the body. So this parser only has to
turn the DOM into blocks — anchoring, noise and breadcrumbs are the shared
`pdf.build()`, which is what keeps both parsers emitting one chunk shape.
"""
import re, sys, json
from bs4 import BeautifulSoup

from .pdf import build

CLEAN = re.compile(r'\s+')
# the section number sits in its own <a> tag, so the extracted text reads
# "1 . This Act ..." — pull the dot back onto the number before anchoring
NUMDOT = re.compile(r'^(\d+[A-Z]*)\s+\.')


def blocks(html):
    soup = BeautifulSoup(html, "html.parser")
    out = []
    # front matter: everything before the first numbered section
    for node in soup.select(".descriptioncontent"):
        t = CLEAN.sub(" ", node.get_text(" ", strip=True))
        if t:
            out.append({"page": None, "text": t, "note": None, "opener": False})
    for node in soup.select(".sectioncontent"):
        t = NUMDOT.sub(r'\1.', CLEAN.sub(" ", node.get_text(" ", strip=True)))
        if not t:
            continue
        note = None
        row = node.find_parent("tr")
        if row:
            n = row.select_one(".sectionshorttitle")
            if n:
                note = CLEAN.sub(" ", n.get_text(" ", strip=True)).strip(" .") or None
        out.append({"page": None, "text": t, "note": note, "opener": True})
    return out


def text(html):
    """Visible text only — QA compares chunks against this, never against the
    markup, which would bury the ratio in tags."""
    return CLEAN.sub(" ", BeautifulSoup(html, "html.parser").get_text(" ", strip=True))


def parse(path_or_html):
    html = path_or_html
    if not html.lstrip().startswith("<"):
        html = open(html, encoding="utf8", errors="replace").read()
    b = blocks(html)
    title = ""
    m = re.search(r'<title>(.*?)</title>', html, re.S | re.I)
    if m:
        title = CLEAN.sub(" ", m.group(1)).strip()
    return build(b, title=title)


def _selfcheck():
    doc = """<html><title>Widgets Act, No. 3 of 1991</title><body>
    <p class="descriptioncontent">AN ACT TO PROVIDE FOR WIDGETS.</p>
    <table><tr><td><font class="sectionshorttitle">Short title.</font></td>
    <td><p class="sectioncontent">1. This Act may be cited as the Widgets Act.</p></td></tr></table>
    <table><tr><td><font class="sectionshorttitle">Widgets.</font></td>
    <td><p class="sectioncontent">2. Widgets are good.</p></td></tr></table>
    </body></html>"""
    ch = parse(doc)
    assert [c["kind"] for c in ch] == ["preamble", "section", "section"], [c["kind"] for c in ch]
    # the number-in-an-anchor-tag case, which is how lankalaw actually marks up
    split = parse('<html><title>T</title><td><p class="sectioncontent">'
                  '<a>4</a>. Four.</p></td></html>')
    assert split[0]["kind"] == "section" and split[0]["anchor"] == "4", split[0]
    assert ch[1]["anchor"] == "1" and ch[1]["note"] == "Short title", ch[1]
    assert ch[1]["breadcrumb"] == "Widgets Act, No. 3 of 1991 › s. 1 › Short title", ch[1]["breadcrumb"]
    assert ch[0]["pages"] == []
    print("selfcheck ok:", len(ch), "chunks")


if __name__ == "__main__":          # python3 -m etl.parse.html [file.html]
    if len(sys.argv) > 1:
        json.dump(parse(sys.argv[1]), sys.stdout, indent=1)
    else:
        _selfcheck()
