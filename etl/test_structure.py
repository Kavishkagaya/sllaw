"""python3 -m etl.test_structure -- the quote fence and labels, the rules most likely to regress."""
from etl.structure import INTRO, LABEL, SECTION, TERM, quote_delta

# defined terms are not quotes; real quote openers are
assert TERM.match("'bank' means a bank licensed under")
assert TERM.match("'executive' when used with reference to a trade union")
assert TERM.match("'public finance 'includes -")
assert not TERM.match("'3. (1) The 'principal' enactment")
assert TERM.match("“individual”—") and TERM.match("'net income':") and not quote_delta("“individual”—", False)
assert not quote_delta("“net income”, in relation to any individual, means the balance of his assessable income", False)
assert not quote_delta("'bank' means a bank licensed;", False)
assert quote_delta("'Provided that, notwithstanding the provisions of subsection (2)-", False)
assert not quote_delta("''Minister' means the Minister of Finance;';", False)        # opens and closes
assert not quote_delta("the output tax is computed.'.", True)                         # closes
assert not quote_delta("on the next Rs. 500,000 14 per centum.\". 14 per centum", True)  # closes mid-block
assert quote_delta("any registered person who is engaged in supplying", True)          # stays open
# amending formula opens a quote; a principal Act's "following powers" doesn't
assert INTRO.search("is hereby repealed and the following section substituted therefor:-")
assert not INTRO.search("the Commission shall have the following powers:-")
assert SECTION.match("12A. (1) Notwithstanding")[1] == "12A"
assert LABEL.match("(iii) at any election")[1] == "(iii)"
print("ok rules")

# amendment edges (etl/graph.py)
import etl.graph as g
from etl.graph import edges
g.CHAPTERS.update({"bribery": "cap:26", "school teachers pension": "cap:432"})   # chapter numbers resolve by name
def sec(num, note, *paras):
    return {"num": num, "note": note, "paras": [{"label": None, "text": t, "quoted": q} for t, q in paras]}
doc = {"long_title": "AN ACT TO AMEND THE VALUE ADDED TAX ACT, NO. 14 OF 2002", "sections": [
    sec("1", "Short title", ("This Act may be cited as the Value Added Tax (Amendment) Act, No. 32 of 2023.", False)),
    sec("2", "Amendment of section 22 of Act, No. 14 of 2002", ("Section 22 of the Value Added Tax Act, No. 14 of 2002 "
        "(hereinafter referred to as the 'principal enactment') is hereby amended by the following:-", False),
        ("'Provided that ...';", True)),
    sec("3", "Insertion of new sections12A, 12b and 12C in the principal enactment", ("...", False)),
    sec("4", "Replacement of Form F of the Second Schedule", ("...", False)),
    sec("5", "Repeal of Schedules in the principal enactment", ("...", False)),
    sec("6", "Repeals", ("The Bribery Act (Chapter 26) and the Law, No. 1 of 1975 are hereby repealed.", False))]}
E = {(e[2], e[3], e[4]) for e in edges(doc, "act:32/2023", "2023-12-13")}
assert ("amends_act", "act:14/2002", None) in E
assert ("amends", "act:14/2002", "22") in E                   # explicit target in the note
assert {("inserts", "act:14/2002", n) for n in ("12A", "12B", "12C")} <= E   # no space, lower-case letter
assert ("replaces", "act:14/2002", "Second Schedule") in E    # no target in note -> principal enactment
assert ("repeals", "act:14/2002", "Schedules") in E           # not "Of Schedules"
assert {("repeals_act", "cap:26", None), ("repeals_act", "law:1/1975", None)} <= E
new = [e for e in edges(doc, "act:32/2023", None) if e[2] == "amends" and e[4] == "22"][0][6]
assert new == "'Provided that ...';"                          # only the quoted text is the new wording
print("ok edges")
# one law, two names
d2 = {"long_title": "AN ACT TO AMEND THE SCHOOL TEACHERS PENSION ACT, No. 44 OF 1953", "sections": [
    sec("2", "Insertion of Sections 5A and 5B in Chapter 432.", ('The School Teachers Pension Act, (Chapter 432) '
        '(hereinafter referred to as "the principal enactment") is hereby amended', False)),
    sec("3", "Amendment of section 6 of the principal enactment.", ("Section 6 of the principal enactment ...", False))]}
E2 = {(e[2], e[3], e[4], e[7]) for e in edges(d2, "act:32/2008", None)}
assert ("amends", "cap:432", "6", "Amendment of section 6 of the principal enactment.") in E2   # double-quoted definition
assert ("same_as", "act:44/1953", None, "also cap:432") in E2
d3 = {**d2, "long_title": "AN ACT TO AMEND THE MUNICIPAL COUNCILS ORDINANCE AND THE PRADESHIYA SHABHA ACT, NO. 15 OF 1987."}
assert not [e for e in edges(d3, "act:21/2012", None) if e[2] == "same_as"]               # two laws named
print("ok aliases")
# commencement
from etl.structure import commencement, parse_date
assert parse_date("January 1, 2011 unless") == "2011-01-01" and parse_date("the 1st day of April, 2011") == "2011-04-01"
assert parse_date("01st April 2012") == "2012-04-01"
c1 = lambda t: commencement({"sections": [sec("1", "Short title", (t, False))]}, "2020-05-05")
d, k = c1("This Act may be cited as X Act, No. 9 of 2011 and shall be deemed to have come into operation on January 1, 2011.")
assert (d, k["kind"]) == ("2011-01-01", "deemed")                      # "No." inside the sentence
assert c1("This Act may be cited as X and shall come into operation on such date as the Minister may appoint by Order")[1]["kind"] == "appointed"
assert c1("The provisions of this Act, shall come into operation on April 1, 2012: Provided however-")[0] == "2012-04-01"
assert c1("This Act may be cited as X Act, No. 5 of 2020.") == ("2020-05-05", {"kind": "unstated", "text": None})
print("ok commencement")
# "as last amended by" names an amending Act, not the principal one
d4 = {"long_title": "AN ACT TO AMEND THE FINANCE ACT, NO. 38 OF 2000", "sections": [
    sec("2", "Amendment of section 5 of the principal enactment.", ("Section 5 of the Finance Act, No. 38 of 2000, as last "
        "amended by Act, No. 10 of 2002 (hereinafter referred to as the 'principal enactment') is hereby amended", False))]}
E4 = {(e[2], e[3], e[4]) for e in edges(d4, "act:19/2003", None)}
assert ("amends", "act:38/2000", "5") in E4 and not [e for e in E4 if e[0] == "same_as"]
print("ok principal")
# principal enactment named by title only, "Chapter N" in the defining note (30/1987, 24/1962)
g.CHAPTERS.update({"medical": "cap:105x", "ceylon state mortgage bank": "cap:398x"})
d5 = {"long_title": "AN ACT TO AMEND THE MEDICAL ORDINANCE", "sections": [
    sec("2", "Amendment of section 5 of Chapter 105.", ("Section 5 of the Medical Ordinance (hereinafter referred to as "
        "the \u201cprincipal enactment\u201d) is hereby amended", False)),
    sec("3", "Amendment of section 29 of the principal enactment.", ("Section 29 of the principal enactment ...", False))]}
E5 = {(e[2], e[3], e[4]) for e in edges(d5, "act:30/1987", None)}
assert {("amends", "cap:105x", "5"), ("amends", "cap:105x", "29"), ("amends_act", "cap:105x", None)} <= E5, E5
# unquoted definition, "hereafter"; a long title naming two laws (one without a number) is no principal
d6 = {"long_title": "AN ACT TO AMEND THE CEYLON STATE MORTGAGE BANK ORDINANCE, AND THE FINANCE ACT, No. 11 OF 1963.",
      "sections": [sec("2", "Amendment of section 3 of Chapter 398.", ("Section 2 of the Ceylon State Mortgage Bank Ordinance, "
                       "hereafter in this Act referred to as the principal enactment, is hereby amended", False)),
                   sec("3", "Amendment of section 9 of the principal enactment.", ("...", False))]}
assert ("amends", "cap:398x", "9") in {(e[2], e[3], e[4]) for e in edges(d6, "act:33/1968", None)}
# a number in the text younger than the Act itself is a typo: the long title's law wins (CommonLII law:30/1978)
d7 = {"long_title": "A LAW TO AMEND THE INLAND REVENUE ACT, No. 4 OF 1963", "sections": [
    sec("2", "Amendment of section 3 of Act No. 4 of 1968", ('Section 3 of the Inland Revenue Act, No. 4 of 1983, (hereinafter '
        'referred to as the " principal enactment ") is hereby amended', False)),
    sec("3", "Amendment of section 4 of the principal enactment", ("...", False)),
    sec("4", "Repeal of Chapter 170.", ("Chapter 170 is hereby repealed.", False))]}
E7 = {(e[2], e[3], e[4]) for e in edges(d7, "law:30/1978", None)}
assert ("amends", "act:4/1963", "4") in E7 and not [e for e in E7 if e[1] == "act:4/1983" and e[0] != "cites"], E7
assert ("repeals_act", "chapter:170", None) in E7
print("ok principal by name")
# Constitution amendments: documents.gov.lk lists them as 0/YYYY
from etl.structure import act_key
amd = lambda t: {"sections": [sec("1", "Short title", (t, False))]}
assert act_key({"act_no": "0/2010", "listing": {"id": "x"}}, amd("This Act may be cited as the Eighteenth Amendment to the Constitution.")) == "amendment:18"
assert act_key({"act_no": "0/2022", "listing": {"id": "x"}}, amd("This Act may be cited as the Twenty First Amendment to the Constitution.")) == "amendment:21"
assert act_key({"act_no": "0/2022", "listing": {"id": "x"}}, amd("This Act may be cited as X.")) == "other:x"
print("ok amendments")
d8 = {"long_title": "AN ACT TO AMEND THE CONSTITUTION OF THE DEMOCRATIC SOCIALIST REPUBLIC OF SRI LANKA", "sections": [
    sec("8", "Amendment of Article 91 of the Constitution", ("Article 91 of the Constitution is hereby amended", False)),
    sec("9", "Insertion of new Articles 104A and 104B in the Constitution", ("...", False))]}
E8 = {(e[2], e[3], e[4]) for e in edges(d8, "amendment:21", None)}
assert {("amends_act", "constitution", None), ("amends", "constitution", "91"), ("inserts", "constitution", "104B")} <= E8, E8
print("ok constitution edges")
from etl.structure import SCHED_HEAD
assert SCHED_HEAD.match("[SECTION 6 (2)] FIRST SCHEDULE") and SCHED_HEAD.match("THIRD SCHEDULE [Section 7 (1) (b)]")
assert SCHED_HEAD.match("SCHEDULE I [Section 2(4)]")
print("ok schedule headings")
from etl.graph import sched_names
assert sched_names("Replacement of the First and Second Schedules to the principal enactment.") == ["First Schedule", "Second Schedule"]
assert sched_names("Replacement of Schedules I, II, III,IV, IVA and V of the principal") == [f"Schedule {x}" for x in ("I", "II", "III", "IV", "IVA", "V")]
assert sched_names("Amendment of the Second Schedule") == ["Second Schedule"] and sched_names("Repeal of Schedules in the principal") == ["Schedules"]
print("ok schedule lists")
assert not quote_delta("'preceding year') had any profits and income, other than the net annual value", False)
assert quote_delta("'3. (1) The Minister may (by Order) make regulations", False)    # a real quotation still opens
print("ok carried-over terms")
qs = lambda *t: {"num": "9", "paras": [{"label": None, "text": x, "quoted": True} for x in t]}
d9 = {"long_title": "AN ACT TO AMEND THE VALUE ADDED TAX ACT, NO. 14 OF 2002", "sections": [
    {**qs("“25A. (1) Every person ...", "25B. Where ..."), "note": "Insertion of new Chapter IIIA in the principal enactment"},
    {**qs("1. Name ...", "2. Address ..."), "num": "10", "note": "Replacement of the Schedule to the principal enactment"}]}
E9 = {(e[2], e[3], e[4]) for e in edges(d9, "act:7/2003", None)}
assert {("inserts", "act:14/2002", "Chapter IIIA"), ("replaces", "act:14/2002", "Schedule")} <= E9, E9
print("ok inserted Parts")
g.TITLES.update({"banking": "act:30/1988"})
d10 = {"long_title": "AN ACT TO AMEND THE BANKING ACT, NO. 33 OF 1995", "sections": [
    sec("2", "Replacement of the long title of Act No. 30 of 1998.", ("The long title of the Banking Act, No. 33 of 1995 (hereinafter "
        "referred to as the “principal enactment”) is hereby repealed", False)),
    sec("3", "Amendment of section 2 of the principal enactment.", ("Section 2 of the principal enactment is hereby amended", False))]}
E10 = {(e[2], e[3], e[4]) for e in edges(d10, "act:33/1995", None)}
assert ("amends", "act:30/1988", "2") in E10 and not [e for e in E10 if e[1] == "act:30/1998" and e[0] != "cites"], E10
print("ok misprinted numbers")
d11 = {"long_title": "AN ACT TO AMEND THE INCOME TAX ORDINANCE.", "sections": [
    sec("7", "Amendment of section 10 of Chapter 188.", ("Section 10 of the principal enactment is hereby amended", False))]}
assert ("amends", "chapter1938:188", "10") in {(e[2], e[3], e[4]) for e in edges(d11, "act:3/1956", None)}
assert ("amends", "chapter:188", "10") in {(e[2], e[3], e[4]) for e in edges(d11, "act:3/1965", None)}
print("ok 1938 chapter numbers")
d12 = {"long_title": "AN ACT TO PROVIDE FOR THE ESTABLISHMENT OF THE SRI LANKA NURSES COUNCIL", "sections": [
    sec("27", "Repeal", ("(1) Part IX of the Medical Ordinance (Chapter 105) is hereby repealed.", False)),
    sec("28", "Repeal", ("The Nurses Ordinance (Chapter 106) is hereby repealed.", False))]}
E12 = {(e[2], e[3], e[4]) for e in edges(d12, "act:19/1988", None)}
assert not [e for e in E12 if e[0] == "repeals_act" and "105" in e[1]] and [e for e in E12 if e[0] == "repeals" and "105" in e[1]], E12
assert ("repeals_act", "chapter:106", None) in E12
print("ok partial repeals")
from etl.structure import section_table
assert section_table([["Repeal of Article 155G of the Constitution.", "48. Article 155G of the Constitution is hereby repealed."]])
assert not section_table([["Column I", "Column II"], ["ENACTMENTS", "AMENDMENTS"], ["6. The Rubber Control Act", "1. For section 16, substitute"]])
assert not section_table([["Sum invested", "Period in years"], ["30", "5"]])
print("ok section tables")
from etl.docs import chunks
P = lambda t, note=None: {"text": t, "note": note}
ch = chunks([P("Price : Rs. 36.00"), P("AN ACT TO PROVIDE FOR SPORTS."),
             P("1. This Act may be cited as the Sports Act.", "Short title."),
             P("2. (1) The Director shall inform the Council of such fact and the", "Effect of registering."),
             P("Council shall thereupon issue a directive."), P("3. No person shall bet.", "Offence.")])
assert "Price" not in ch[0][1] and "AN ACT" in ch[0][1], ch[0]
assert ch[2] == ("2", "2. (1) The Director shall inform the Council of such fact and the\n\nCouncil shall thereupon issue a "
                 "directive. *Effect of registering.*", "section 2 — Effect of registering."), ch[2]
# a law with no notes: an OCR gap in the numbering (3 lost) doesn't stop the sections after it
ch = chunks([P(f"{n}. Section {n} of the Customs Ordinance says this much and no more.") for n in (1, 2, 4, 5)])
assert [c[0] for c in ch] == ["1", "2", "4", "5"], ch
print("ok chunks: notes, cover, gaps")

# one sentence LightOn cut into two blocks is one paragraph again; not a cover line, a heading or a new item
from etl.docs import join_split
j = join_split([P("4. Where the Director-General is satisfied, he shall notify the Regulatory Council of such fact and the"),
                P("Regulatory Council shall thereupon register the product.", "Effect of registering.")])
assert len(j) == 1 and j[0]["text"].endswith("fact and the Regulatory Council shall thereupon register the product.") \
    and j[0]["note"] == "Effect of registering.", j
L = "(a) a person who carries on business in the manner set out in this section and the"
for nxt in ("(b) any other person.", "5. This Act shall apply.", "THIRD SCHEDULE", "PART II"):
    assert len(join_split([P(L), P(nxt)])) == 2, nxt
assert len(join_split([P("Printed on the Order of Government"), P("Published as a Supplement to Part II")])) == 2
print("ok join split sentences")

# a gazette without its masthead, running heads and printer's code
from etl.docs import gazette_body
g = gazette_body([P(t) for t in ["The Gazette of the Democratic Socialist Republic of Sri Lanka", "EXTRAORDINARY",
                                 "No. 2491/12 - MONDAY, JUNE 01, 2026", "(Published by Authority)", "PART I : SECTION (I) - GENERAL",
                                 "Government Notifications", "CEYLON PETROLEUM CORPORATION ACT, No. 28 OF 1961", "Order under Section 66(1)(a)",
                                 "IV ( ) - GAZETTE EXTRAORDINARY OF THE DEMOCRATIC SOCIALIST REPUBLIC OF SRI LANKA - 2026.06.01", "w",
                                 "Anura Karunathilaka, Minister of Energy.", "At Colombo, 30th May, 2026. EOG 06 - 0063", "EOG 06 - 0063"]])
assert [p["text"] for p in g] == ["CEYLON PETROLEUM CORPORATION ACT, No. 28 OF 1961", "Order under Section 66(1)(a)",
                                  "Anura Karunathilaka, Minister of Energy.", "At Colombo, 30th May, 2026. EOG 06 - 0063"], g
print("ok gazette body")
