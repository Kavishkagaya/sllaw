"""python3 -m etl.test_structure -- the quote fence and labels, the rules most likely to regress."""
from etl.structure import INTRO, LABEL, SECTION, TERM, quote_delta

# defined terms are not quotes; real quote openers are
assert TERM.match("'bank' means a bank licensed under")
assert TERM.match("'executive' when used with reference to a trade union")
assert TERM.match("'public finance 'includes -")
assert not TERM.match("'3. (1) The 'principal' enactment")
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

# Jev answers -> one label (etl/label.py)
from etl.label import kind, unsure
a = {"type": "section_start", "type_p": 0.97, "type_conf": 0.95, "quoted": 0.9, "cont": 0.1}
assert kind(a) == "quoted"                                   # a quoted section is not a section
assert kind({**a, "quoted": 0.1}) == "section_start"
assert kind({**a, "type": "provision", "quoted": 0.1}) == "section_text"
assert kind({**a, "type": "schedule_content"}) == "quoted"          # a schedule inserted into another law
assert kind({**a, "type": "schedule_content", "quoted": 0.1}) == "schedule_text"
assert kind({**a, "type": "furniture"}) == "furniture"
assert not unsure({**a, "quoted": 0.95}) and unsure({**a, "quoted": 0.5}) and unsure({**a, "type_conf": 0.4})
print("ok labels")

# amendment edges (etl/graph.py)
from etl.graph import edges
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
from etl.graph import commencement, parse_date
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
