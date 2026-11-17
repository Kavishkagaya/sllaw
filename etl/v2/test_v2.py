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
     mock.patch.object(stages, "execute_values", lambda cur, sql, rows, page_size, fetch: seen.append(f"write {len(rows)}") or [(True,)]), \
     mock.patch.object(stages.B, "r2", lambda: (mock.Mock(), "bucket")):
    stages.listing(lambda: seen.append("connect") or Conn(), "parliament.lk/acts")
assert seen == ["crawl", "connect", "write 1", "commit", "close"], seen
print("ok listing connects after the crawl")

# court spiders (court-judgments #63): rows parsed from the page shapes seen 2026-11-16, keys from the court's file
from etl.spiders import courts
from etl.v2.run import v1_type
CA = '''<tr>
    <td>2024-12-20</td>
    <td>CA/WRT/0692/2024 <button type="button" class="jd-view" data-case="CA/WRT/0692/2024" data-date="2024-12-20"
      data-by="HON. JUSTICE P. KUMARARATNAM" data-parties="Lanwa v. Central Environmental Authority &amp; Others"
      data-keywords="Writ of Mandamus" data-legislation="Article 140 of the Constitution"
      data-file="uploads/judgments/CA-Writ-0692.24-1-2.pdf">View More</button></td></tr>
<tr>
    <td>2024-12-19</td><td>CA/WRT/0001/2024 <button data-case="CA/WRT/0001/2024" data-file="">x</button></td></tr>'''
rows, n = courts.ca_rows(CA)
assert n == 2 and len(rows) == 1, (n, rows)
assert rows[0]["url"] == "https://courtofappeal.lk/uploads/judgments/CA-Writ-0692.24-1-2.pdf"
assert rows[0]["parties"] == "Lanwa v. Central Environmental Authority & Others" and rows[0]["date"] == "2024-12-20"
assert courts.key("ca", rows[0]["url"]) == "ca:ca-writ-0692.24-1-2"
long = "https://courtofappeal.lk/uploads/judgments/30.-PRINT-FINAL-FINAL-CA-TAX-16-2018-Commission-income-earned-outside-Sri-Lanka-30.07.2022-AutoRecovered-5-1.pdf"
k1, k2 = courts.key("ca", long), courts.key("ca", long.replace("5-1", "5-2"))
assert len(k1) <= courts.KEY_MAX and len(k2) <= courts.KEY_MAX and k1 != k2 and k1 == courts.key("ca", long), (k1, k2)
assert k1.startswith("ca:30.-print-final-final-ca-tax-16-2018"), k1
print("ok court keys fit", courts.KEY_MAX)
SC = '''<tr>
    <td data-order="2026-08-07"><span class="jm-fe-date-badge">07 Aug 2026</span></td>
    <td><span class="jm-fe-case-code">SC/APPEAL/133/2018</span></td>
    <td><div class="jm-fe-parties-cell"><span class="short-text">B. G. Dingiri Banda</span>
        <span class="full-text">B. G. Dingiri Banda,
No. 17 Vs. R.M. Dasanayaka</span><button>View More</button></div></td>
    <td><div class="jm-fe-judges-list">
      <div class="jm-fe-judge-line"><span class="jm-fe-judge-badge">&#9878; Hon.Justice Sampath B. Abayakoon</span>
        <a class="jm-fe-dl-btn-sm" href="https://web.archive.org/web/20260820033143/https://supremecourt.lk/wp-content/uploads/judgements/sc_appeal_133_2018.pdf">Download</a></div>
      <div class="jm-fe-judge-line"><span class="jm-fe-judge-badge">&#9878; Hon.Justice A</span></div>
    </div></td>
    <td style="display:none;">Partition</td><td style="display:none;"></td></tr>'''
rows = courts.sc_rows(SC)
assert len(rows) == 1, rows
r = rows[0]
assert r["url"] == "https://supremecourt.lk/wp-content/uploads/judgements/sc_appeal_133_2018.pdf", r["url"]
assert (r["case"], r["date"], r["judge"], r["parties"], r["keywords"], r["legislation"]) == (
    "SC/APPEAL/133/2018", "2026-08-07", "Hon.Justice Sampath B. Abayakoon", "B. G. Dingiri Banda, No. 17 Vs. R.M. Dasanayaka",
    "Partition", None), r
assert courts.recent([{"date": "2020-12-31"}, {"date": "2021-01-01"}]) == [{"date": "2021-01-01"}]
src, url, title, d, meta = stages._court(r)
assert (src, url, title) == ("supremecourt", r["url"], "SC/APPEAL/133/2018 (2026-08-07)")
assert v1_type(src, meta) == ("supreme_court_judgment", "sc:sc_appeal_133_2018"), v1_type(src, meta)
# the pipeline fetches from the courts' own sites only; the mirror and Wayback were a one-time backfill (user, 2026-11-16)
import inspect
for mod in (stages, R if "R" in dir() else __import__("etl.v2.run", fromlist=["x"]), courts, __import__("etl.fetch", fromlist=["x"])):
    src_text = inspect.getsource(mod)
    assert "lk_datasets" not in src_text and "githubusercontent" not in src_text and "WAYBACK_FIRST" not in src_text, mod.__name__
print("ok court rows and keys")


# a court spider's years: its first pass from 2021, then only this year (and last year in January)
class YearsConn:
    def __init__(self, held): self.held = held
    def cursor(self):
        cur = mock.MagicMock(); cur.__enter__.return_value.fetchall.return_value = [(y,) for y in self.held]; return cur
    def commit(self): pass
    def close(self): pass


from datetime import date as _date
for today, held, want in ((_date(2026, 11, 16), [], [2021, 2022, 2023, 2024, 2025, 2026]),
                          (_date(2026, 11, 16), [2021, 2022, 2023, 2024, 2025, 2026], [2026]),
                          (_date(2027, 1, 3), [2021, 2022, 2023, 2024, 2025, 2026], [2026, 2027]),
                          (_date(2026, 11, 16), [2021, 2022, 2024, 2025, 2026], [2023, 2026])):
    with mock.patch.object(stages, "date", mock.Mock(today=lambda: today)):
        got = stages.court_years(lambda: YearsConn(held), "courtofappeal.lk", "judgments")
    assert got == want, (today, held, got)
assert "courtofappeal.lk/judgments" in stages.SPIDERS and not [x for x in stages.SPIDERS if "wayback" in x or "mirror" in x]
print("ok court years")

# judgments wait for the user's go (court-judgments d4): a plan without keys leaves them out, named keys go in
from etl.v2 import run as R
planned = []
for keys, want in ((None, ["1|a"]), ({"ca:x", "act:1/2020"}, ["1|a", "2|b"])):
    planned.clear()
    with mock.patch.object(R, "db", lambda: mock.MagicMock()), \
         mock.patch.object(stages, "choose", lambda c: [("act:1/2020", "1|a"), ("ca:x", "2|b"), ("sc:y", "3|c")]), \
         mock.patch.object(R.W, "plan", lambda c, st, items: planned.extend(sorted(i for i, _ in items)) or (len(items), 0)):
        R.plan_fetch(keys)
    assert sorted(planned) == want, (keys, planned)
print("ok judgments held from a nightly fetch")

# Wayback is paced: a refused connection waits and tries again, a 404 (never archived) does not (2026-11-16)
from etl import fetch as F
calls = []
def _refused_once(u, tries=4):
    calls.append(u)
    if len(calls) == 1:
        raise ConnectionRefusedError(111, "refused")
    return b"%PDF"
def _missing(u, tries=4):
    calls.append(u)
    raise SystemExit("HTTP 404")
with mock.patch.object(F.acts, "_get", _refused_once), mock.patch.object(F.time, "sleep", lambda s: None):
    assert F.wayback("https://supremecourt.lk/a.pdf") == b"%PDF" and len(calls) == 2
calls.clear()
with mock.patch.object(F.acts, "_get", _missing), mock.patch.object(F.time, "sleep", lambda s: None):
    try:
        F.wayback("https://supremecourt.lk/a.pdf")
        raise AssertionError("a 404 must not be retried")
    except SystemExit:
        assert len(calls) == 1
print("ok wayback pacing")

# judgments (etl/v2/judgment.py): case details first, then paragraphs packed to MAX with their pages
from etl.v2 import judgment as J
from etl.docs import MAX
row = {"case": "CA/WRT/0634/2023", "date": "2024-05-13", "judge": "HON. JUSTICE X", "parties": "A v. B",
       "keywords": "Writ of Certiorari", "legislation": "Industrial Disputes Act ss. 4(1), 17(1), 19; Constitution Article 140"}
paras = [{"text": "JUDGMENT", "page": 1}, {"text": "a" * 900, "page": 1}, {"text": "b" * 900, "page": 2},
         {"text": "c" * 300, "page": 3}, {"text": "", "page": 3}]
ch = J.chunks("ca:ca-wrt-0634-23", row, paras)
assert [c["crumb"] for c in ch] == ["case details", "page 1", "pages 2-3"], [c["crumb"] for c in ch]
cap = [{"text": "IN THE COURT OF APPEAL OF THE DEMOCRATIC SOCIALIST REPUBLIC OF SRI LANKA", "page": 1},
       {"text": "1. Godamunne Bolagedara, Battaramulla. PETITIONER", "page": 1}, {"text": "Vs.", "page": 1},
       {"text": "Before: P. Kumararatnam, J.", "page": 1}, {"text": "Counsel: A for the Petitioner", "page": 1},
       {"text": "Decided on: 13.05.2024", "page": 2}, {"text": "P. Kumararatnam, J.", "page": 2}]
body = [{"text": f"{n}. The petitioner says " + "x" * 400, "page": 2 + n // 3} for n in range(1, 8)]
body.insert(3, {"text": "1. Was the order lawful?", "page": 3})           # a list inside the text restarting at 1
ch2 = J.chunks("ca:x", row, cap + body)
assert [c["crumb"] for c in ch2] == ["case details", "caption", "pages 2-3 · paras 1-3", "pages 3-4 · paras 4-6",
                                    "page 4 · para 7"], [c["crumb"] for c in ch2]
assert ch2[1]["text"].startswith("IN THE COURT OF APPEAL") and ch2[1]["text"].endswith("P. Kumararatnam, J.")
assert J.caption_end(body) == 0 and J.para_numbers(body[:4]) == {}          # no caption line; under 5 numbers
assert ch[0]["text"].startswith("Court of Appeal, CA/WRT/0634/2023, decided 2024-05-13.")
assert "Legislation: Industrial Disputes Act ss. 4(1), 17(1), 19; Constitution Article 140" in ch[0]["text"]
assert all(len(c["text"]) <= MAX for c in ch) and [c["address"] for c in ch] == [f"ca:ca-wrt-0634-23/{n}/1" for n in (1, 2, 3)]
assert J.profile("sc:x")["kind"] == "judgment" and J.profile("sc:x")["code"] == J.CODE
assert "judgment.py" not in " ".join(__import__("etl.v2.build", fromlist=["_SRC"])._SRC)   # laws do not rebuild
print("ok judgment chunks")

# a judgment changes no law: its amending words are cites (judgment-cites-only #80)
from etl import mentions as _M
_t = ["Section 10 of the Inland Revenue Act, No. 10 of 2006 is hereby amended by the repeal of subsection (2) thereof."]
_act = [R.cite_only("act:1/2099", r) for r in _M.mentions("act:1/2099", "", _t)]
_ca = [R.cite_only("ca:ca-tax-46-2019", r) for r in _M.mentions("ca:ca-tax-46-2019", "", _t)]
assert any(_M.kind_of(r) != "cites" for r in _act), [_M.kind_of(r) for r in _act]
assert _ca and len(_ca) == len(_act) and all(_M.kind_of(r) == "cites" and not r["ops"] for r in _ca), [_M.kind_of(r) for r in _ca]
print("ok judgments only cite")

# a gazette's links read as a regulation is worded (gazette-links #81)
from etl.v2 import gazette_links as _G
from etl import refs as _refs


def _gz(t, key="gazette:2099/01"):
    return sorted((_M.kind_of(r), r["dst_doc"], tuple(r["labels"])) for r in _G.apply(key, _M.mentions(key, "", [t]), [t]))


_x = _gz("BY virtue of the powers vested in me under Section 14 of the Registration of Title Act, No. 21 of 1998, I declare.")
assert ("made_under", "act:21/1998", ("14",)) in _x, _x
_x = _gz("Such person shall be liable to the penalties in terms of Section 122(2) in the Pradeshiya Sabhas Act, No. 15 of 1987.")
assert _x and all(k == "cites" for k, *_ in _x), _x                       # a section mentioned, not a power used
_x = _gz("The Gazette Notification No. 1956/17 of March 01, 2016, published under Article 10 of Schedule 'E' of the Customs "
         "(Amendment) Act, No. 02 of 2003 is hereby repealed with effect from 01st March 2016.")
assert not any(d == "act:2/2003" and k != "cites" for k, d, _ in _x) and ("rescinds", "gazette:1956/17", ()) in _x, _x
_x = _gz("The Food Regulations 2022, published in Gazette Extraordinary No. 2319/40 dated February 14, 2023, as amended by "
         "Gazette Extraordinary No. 2364/24 dated December 27, 2023, are hereby amended by the repeal of regulation 1.")
assert ("amends", "gazette:2319/40", ()) in _x and ("cites", "gazette:2364/24", ()) in _x, _x      # the chain only cites
_x = _gz("Goods shipped on Letters of Credit established before 18th October 2015 and not amended subsequently, the Gazette "
         "Notification No. 1901/3 dated 10th February 2015 shall be deemed to be in effect.")
assert ("cites", "gazette:1901/03", ()) in _x, _x
_x = _gz("By repeal of items 1 to 14 of Schedule IX of the Gazette Extraordinary No. 2104/18 dated 01st January 2019.")
assert ("amends", "gazette:2104/18", ()) in _x, _x
_x = _gz("(h) | Musical instruments or parts or accessories thereof (Chapter 92); (ij) | Articles of Chapter 93 (arms).")
assert not _x, _x                                                          # customs tariff chapters, not laws
_x = _gz("the notification issued by me in the exercise of powers vested in me under paragraph (1) of Article 43 of the "
         "Constitution and published in the Gazette Extraordinary No. 1933/13 of 21st September, 2015 is hereby further amended")
assert ("made_under", "constitution", ("43",)) in _x and ("amends", "gazette:1933/13", ()) in _x, _x
_saved = dict(_refs.NAMES)
_refs.NAMES.update({"urban councils": (["cap1956:255"], 1), "municipal councils": (["cap:576"], 0)})
_x = _gz("BY virtue of the powers vested in me under sections 2 and 5 of Urban Councils Ordinance (Chapter 255) and section 27F")
_refs.NAMES.clear(); _refs.NAMES.update(_saved)
assert ("made_under", "cap1956:255", ("2", "5")) in _x, _x                 # the name printed beats the chapter number
_t = ["Such person shall be liable to the penalties in terms of Section 122(2) in the Pradeshiya Sabhas Act, No. 15 of 1987."]
assert _G.apply("act:1/2099", _M.mentions("act:1/2099", "", _t), _t) == _M.mentions("act:1/2099", "", _t)   # Acts untouched
print("ok gazette links")
_x = _gz("do by this Notification amend the Notification No. 902 published in Gazette Extraordinary No. 1544/17 and the "
         "Notification No. 974 published in Gazette Extraordinary No. 1901/19 of February 13, 2015 is hereby rescinded.")
assert ("rescinds", "gazette:1901/19", ()) in _x and ("amends", "gazette:1544/17", ()) in _x, _x    # the nearer verb
print("ok gazette nearer verb")

from etl.v2.build import doc_year   # the year filter's year: a gazette's from its date (chat-regulations #82)
assert doc_year("act:9/2023") == 2023 and doc_year("gazette:2345/03", {"certified": "2023-08-14"}) == 2023
assert doc_year("gazette:2345/03") is None and doc_year("cap:107", {"certified": "1980-01-01"}) is None
print("ok doc year")
