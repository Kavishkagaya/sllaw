"""python3 -m etl.v2.test_v2 -- the v2 builder (stages 4-5) against etl.docs.chunks() and its own rules."""
from etl import docs
from etl.v2 import chunk as c5, tree as t4
from etl.v2.profiles import profile


def P(text, note=None, rows=None):
    return {"text": text, "note": note, **({"rows": rows} if rows else {})}


def v2(key, title, paras):
    prof = profile(key, title)
    tree, info = t4.build([dict(p) for p in paras], prof)
    return c5.chunks(key, tree, prof), tree, info


def same_as_today(key, title, paras):
    """Labels and chunk texts equal to etl.docs.chunks() on the same paragraphs."""
    amending = "AMENDMENT" in title.upper()
    old = docs.chunks([dict(p) for p in paras], "section", parts=not amending)
    new, _, _ = v2(key, title, paras)
    assert [l for l, _, _ in old] == [c["label"] for c in new], ([l for l, _, _ in old], [c["label"] for c in new])
    assert [t for _, t, _ in old] == [c["text"] for c in new]
    return new


long = "This is a long body sentence that keeps going so that the section has real text in it. " * 3
act = [P("SRI LANKA ACT, No. 9 OF 2023"), P("AN ACT TO PROVIDE FOR THE ESTABLISHMENT OF A BOARD"),
       P("BE it enacted by the Parliament of the Democratic Socialist Republic of Sri Lanka as follows:-"),
       P("1. This Act may be cited as the Board Act, No. 9 of 2023.", "Short title."),
       P("PART I"), P("ESTABLISHMENT OF THE BOARD"),
       P("2. (1) There shall be established a Board. " + long, "Establishment of the Board."),
       P("(a) to do the first thing;"), P("(b) to do the second thing;"),
       P("Provided that nothing in this section shall apply to the Minister."),
       P("3. The Board shall meet. " + long, "Meetings."),
       P("5. A list item in the body with a jump and no note"),
       P("PART II"), P("POWERS"),
       P("4. The Board may make rules. " + long * 8, "Rules."),
       P("FIRST SCHEDULE"), P("1. Name of applicant"), P("2. Address of applicant"),
       P("Name | Address | Shares\nA | B | 1\nC | D | 2", rows=[["Name", "Address", "Shares"], ["A", "B", "1"], ["C", "D", "2"]])]
ch = same_as_today("act:9/2023", "Board", act)
labels = [c["label"] for c in ch if c["label"]]
assert labels == ["1", "2", "3", "4", "First Schedule"], labels            # "5." rejected (jump without a note)
assert [c["address"] for c in ch][:3] == ["act:9/2023/front/1", "act:9/2023/1/1", "act:9/2023/Part I/2/1"], [c["address"] for c in ch][:3]
assert any(c["address"].startswith("act:9/2023/Part II/4/") and c["address"].endswith("/2") for c in ch)   # cut into pieces
assert ch[2]["crumb"] == "Part I — ESTABLISHMENT OF THE BOARD › section 2 — Establishment of the Board.", ch[2]["crumb"]
assert len({c["id"] for c in ch}) == len(ch)
again = c5.chunks("act:9/2023", v2("act:9/2023", "Board", act)[1], profile("act:9/2023", "Board"))
assert [c["id"] for c in again] == [c["id"] for c in ch]                     # deterministic
_, tree, info = v2("act:9/2023", "Board", act)
kinds = [n["kind"] for _, u in t4.units(tree) for n in u["children"]]
assert {"item", "proviso", "table", "heading_text"} <= set(kinds), kinds
assert len(info["rejected"]) == 1
print("ok parity and identity")

# an amending law: Parts are not scopes; the same labels as today
am = [P("1. This Act may be cited as the Board (Amendment) Act.", "Short title."),
      P("2. The following Part is hereby inserted:-", "Insertion of new Part."), P("PART IIIA"), P("“25A. The Board shall"),
      P("3. Section 9 of the principal enactment is hereby repealed.", "Repeal of section 9.")]
ch, _, _ = v2("act:10/2024", "Board (Amendment)", am)       # not as today: the quoted Part stays in section 2
assert [c["label"] for c in ch if c["label"]] == ["1", "2", "3"]
assert "PART IIIA" in next(c["text"] for c in ch if c["label"] == "2")
assert all("Part" not in c["address"] for c in ch)
assert t4.kind_of("“25A. The Board shall", {}, None)[0] == "quote"

# item levels: "(i)" after "(h)" is a letter, otherwise roman
assert t4.kind_of("(i) the ninth", {}, "h")[1]["level"] == 2
assert t4.kind_of("(i) the first", {}, "a")[1]["level"] == 3
assert t4.kind_of("(2) second", {}, None)[1]["level"] == 1
assert t4.kind_of("“court” means the High Court;", {}, None)[0] == "definition"
assert t4.kind_of("[§ 2, 55 of 1961.]", {}, None)[0] == "annotation"
assert t4.kind_of("By His Excellency's Command,", {}, None)[0] == "end"

# a repeated label gets an occurrence number; a table over MAX is cut by rows with its header repeated
rows = [["Code", "Description", "Rate"]] + [[f"{i:04d}", "x" * 60, "10%"] for i in range(60)]
text = "\n".join(" | ".join(r) for r in rows)
sched = [P("1. Cited as.", "Short title."), P("SCHEDULE"), P(text, rows=rows), P("SCHEDULE"), P("Second list")]
ch, _, _ = v2("gazette:1/1", "Order", sched)
adr = [c["address"] for c in ch]
assert "gazette:1/1/Schedule#2/1" in adr, adr
tab = [c["text"] for c in ch if c["address"].startswith("gazette:1/1/Schedule/")]
assert len(tab) > 1 and all(t.split("\n\n")[-1].startswith("Code | Description | Rate") for t in tab), [t[:30] for t in tab]

# contents page: dropped from the text, kept as the expected list
toc = [P("ARRANGEMENT OF SECTIONS")] + [P(f"{i}. Heading number {i}") for i in range(1, 8)] + \
      [P(f"{i}. " + long, f"Note {i}.") for i in range(1, 8)]
ch, _, info = v2("act:2/2020", "Toc", toc)
assert info["contents_dropped"] == 7 and set(info["contents"]) == {str(i) for i in range(1, 8)}, info
assert [c["label"] for c in ch if c["label"]] == [str(i) for i in range(1, 8)]
print("ok kinds, tables, contents")

# checks: a gap says why (here: merged into the paragraph before), a stray number is a refused opener
from etl.v2 import checks
paras = [P("1. Cited as the Act.", "Short title."), P("2. " + long + " 3. The Board shall meet monthly.", "Second."),
         P("4. " + long, "Fourth."), P("7. a stray number")]
prof = profile("act:3/2021", "Test")
tree, info = t4.build([dict(p) for p in paras], prof)
iss = checks.check("act:3/2021", prof, paras, {}, tree, info, c5.chunks("act:3/2021", tree, prof))
gap = [i for i in iss if i["check"] == "gap"]
assert [i["where"] for i in gap] == ["act:3/2021 section 3"] and gap[0]["cause"].startswith("inside"), gap
assert any(i["check"] == "rejected_opener" and "jump without a note" in i["cause"] for i in iss), iss
print("ok checks")

# quoted text an amendment inserts is not the law's own section (here its number is the law's next one too);
# the law's own next section still opens, and so does one that does not amend (a new Schedule added)
q = [P("10. Cited as the Institute (Amendment) Act.", "Short title."),
     P("11. Section 12 of the principal enactment is hereby repealed and the following section substituted therefor:-", "Replacement of section 12."),
     P("12. The members of the Institute shall be paid such remuneration.", "Remuneration."),
     P("(2) Such remuneration shall be paid monthly."),
     P("12. Section 15 of the principal enactment is hereby amended by the substitution.", "Amendment of section 15."),
     P("13. The following new Schedule is added immediately after the First Schedule:-", "Addition of a Schedule."),
     P("“SECOND SCHEDULE"), P("1. Name of the society.”."),
     P("14. In the event of any inconsistency between the Sinhala and Tamil texts, the Sinhala text shall prevail.", "Sinhala text to prevail.")]
ch, tree, _ = v2("act:29/1981", "Institute (Amendment)", q)
assert [c["label"] for c in ch if c["label"]] == ["10", "11", "12", "13", "14"], [c["label"] for c in ch]
assert "remuneration" in next(c["text"] for c in ch if c["label"] == "11")
assert next(c["text"] for c in ch if c["label"] == "12").startswith("12. Section 15")
assert "SECOND SCHEDULE" in next(c["text"] for c in ch if c["label"] == "13")
# an amending formula wins over a quoted fragment placed as its note; an amending note marks the law's own section
q2 = [P("1. Cited as the Wages (Amendment) Act.", "Short title."),
      P("2. Section 4 of the principal enactment is hereby repealed and the following section substituted therefor:-", "Replacement of section 4."),
      P("3. (1) The Board shall meet.", "Meetings."),
      P("3. Section 44 of the principal enactment is hereby amended by the repeal of subsection (3).", "“(3) On conviction of an employer"),
      P("4. In every context in which the Trust is mentioned, the new name shall be substituted.", "General Amendment to the Principal Enactment.")]
ch, _, _ = v2("act:36/1982", "Wages (Amendment)", q2)
assert [c["label"] for c in ch if c["label"]] == ["1", "2", "3", "4"], [c["label"] for c in ch]
print("ok quoted text")

# a quotation opened by its own quote mark (no formula before it): what follows inside it stays quoted
q3 = [P("1. Cited as the Board (Amendment) Act.", "Short title."),
      P("2. Insertion in the principal enactment.", "Insertion of new sections."),
      P("“2A. (1) The Board may appoint committees."), P("2B. (1) A committee shall report."),
      P("(2) Every report shall be in writing.”."),
      P("3. Section 9 of the principal enactment is hereby repealed.", "Repeal of section 9.")]
ch, _, _ = v2("act:7/2021", "Board (Amendment)", q3)
assert [c["label"] for c in ch if c["label"]] == ["1", "2", "3"], [c["label"] for c in ch]
assert "2B. (1) A committee" in next(c["text"] for c in ch if c["label"] == "2")
print("ok opened quotes")

# an amending formula may jump over an opener OCR lost, but not over one that comes next (read out of order),
# and a quoted section the formula named is not taken for the law's own even if it reads like a formula
j = [P("1. Cited as the X (Amendment) Act.", "Short title."),
     P("2. Section 6 of the principal enactment is hereby amended.", "Amendment of section 6."),
     P("3. Section 9 of the principal enactment is hereby amended.", "Amendment of section 9."),
     P("5. Section 18 of the principal enactment is hereby amended as follows:-"),
     P("4. Section 14 of the principal enactment is hereby amended as follows:-"),
     P("6. Section 13 of the principal enactment is hereby repealed and the following section substituted therefor:-", "Replacement of section 13."),
     P("13. The provisions of the enactments in Schedule I are hereby amended or repealed."),
     P("7. Section 13A of the principal enactment is hereby repealed.", "Repeal of section 13A.")]
ch, _, _ = v2("act:58/1981", "X (Amendment)", j)
assert [c["label"] for c in ch if c["label"]] == ["1", "2", "3", "4", "6", "7"], [c["label"] for c in ch]
print("ok jumps")

# a gazette with two by-laws, each numbered from 01; a form's numbered blanks do not start a new one
gz = [P("01. These by-laws may be cited as the Cemetery By-laws and shall come into force on the date of publication."),
      P("02. No person shall cremate a body in the cemetery without the permission of the Chairman of the Council."),
      P("SCHEDULE"), P("1. Name of the applicant : ......................"),
      P("01. These by-laws may be cited as the Library By-laws and shall apply to every library of the Council."),
      P("02. Every member shall return a book within fourteen days of the date on which it was lent to him.")]
ch, _, _ = v2("gazette:1/2", "By-laws", gz)
assert [c["address"].rsplit("/", 1)[0] for c in ch if c["label"] and c["label"][0] == "0"] == \
    ["gazette:1/2/01", "gazette:1/2/02", "gazette:1/2/Instrument 2/01", "gazette:1/2/Instrument 2/02"], [c["address"] for c in ch]
print("ok restarts")

# a number in the margin note and one inside a merged paragraph are mended (only the next expected number)
md = [P("1. Cited as the X Act.", "Short title."),
      P("The Board shall consist of five members appointed by the Minister.", "2 Constitution of the Board."),
      P("3. The Board shall meet once a month at such place as it may decide. 4. Any member may resign by a letter to the Minister.", "Meetings."),
      P("See section 9. 10. This is not the next number and stays.", None)]
ch, _, _ = v2("act:4/2020", "X", md)
assert [c["label"] for c in ch if c["label"]] == ["1", "2", "3", "4"], [c["label"] for c in ch]
print("ok mended numbers")

# a listing crawls first and connects only to write (run 83e03e43, 2026-11-12: Neon closed the idle connection)
from unittest import mock
from etl.v2 import stages
seen = []


class Conn:
    def __enter__(self): return self
    def __exit__(self, *a): seen.append("commit")
    def cursor(self): return mock.MagicMock()
    def close(self): seen.append("close")


with mock.patch.object(stages, "spider_rows", lambda n, l: seen.append("crawl") or [
        ("parliament", "https://parliament.lk/a.pdf", "A Act", "2020-01-01", {"act_no": "1/2020", "lang": "ENGLISH"})]), \
     mock.patch.object(stages, "execute_values", lambda cur, sql, rows, page_size: seen.append(f"write {len(rows)}")), \
     mock.patch.object(stages.B, "r2", lambda: (mock.Mock(), "bucket")):
    stages.listing(lambda: seen.append("connect") or Conn(), "parliament.lk/acts")
assert seen == ["crawl", "connect", "write 1", "commit", "close"], seen
print("ok listing connects after the crawl")
