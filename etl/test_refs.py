"""python3 -m etl.test_refs -- links from flat text (etl/refs.py), on sentences taken from the corpus."""
from etl import graph
from etl.refs import expand, links

graph.CHAPTERS.update({"penal code": "cap:19", "civil procedure code": "cap:101", "weights and measures": "cap:158"})
graph.TITLES.update({"inland revenue": "act:10/2006"})


def ls(text, key="act:5/2010", lt=""):
    return [(k, d, l) for _, k, d, l, *_ in links(key, lt, [text])]


assert expand("65 to 73A") == [str(n) for n in range(65, 74)] + ["73A"]
assert expand("70F to 70N") == ["70F", "70G", "70H", "70J", "70K", "70L", "70M", "70N"]
assert expand("12A, 12B and 12C") == ["12A", "12B", "12C"]
assert expand("11 to 19") == [str(n) for n in range(11, 20)]

P = "2. Section 2 of the Finance Act, No. 11 of 1963 (hereinafter referred to as the “principal enactment”) is hereby amended by the substitution for the words “ten”, of the words “twenty”.\n\n"
F = "act:11/1963"
r = links("act:5/2010", "", [P + "3. Section 38 of the principal enactment is hereby amended in subsection (1) of that section, by the substitution for the words “Municipal Councils”, of the words “local authorities”. *Amendment of section 38 of the principal enactment.*"])
assert ("amends", F, "2") in [x[1:4] for x in r] and ("amends", F, "38") in [x[1:4] for x in r], r
op = next(x for x in r if x[3] == "38")[5]["ops"][0]
assert op["op"] == "substitute" and op["old"] == "Municipal Councils" and op["new"] == "local authorities" and "subsection (1)" in op["loc"], op
# the note is text too
assert ("amends", F, "50") in ls(P + "*Amendment of section 50 of the principal enactment.*")
# "<law> as last amended by Act No. N (hereinafter ...)": the principal is <law> (act:11/2013 -> 9/2009, not 9/2012)
A = "2. Section 2 of the Nation Building Tax Act, No. 9 of 2009 as last amended by Act, No. 9 of 2012 (hereinafter referred to as the “principal enactment”) is hereby amended.\n\n"
assert ("amends", "act:9/2009", "5") in ls(A + "3. Section 5 of the principal enactment is hereby amended.", key="act:11/2013")
A = "2. Section 53, as amended by Ordinance No. 24 of 1938, of the Finance Act, No. 11 of 1963 (hereinafter referred to as the “principal enactment”) is hereby amended.\n\n"
assert ("amends", F, "5") in ls(A + "3. Section 5 of the principal enactment is hereby amended.")
# a name printed with its number links the number only, not also a same-titled law by name
graph.TITLES["finance"] = "law:47/1973"
r = ls("the Co-operative Development Fund established under the Finance Act, No. 11 of 1963;", key="act:16/1985")
assert ("cites", "act:11/1963", None) in r and not any(d == "law:47/1973" for _, d, _ in r), r
assert ("cites", "law:47/1973", None) in ls("any tax under the Finance Act;", key="act:16/1985")

# the part before a numbered cite: the section, not a subsection; not across the principal enactment's own section
r = ls("under paragraph (a) of subsection 9 of section 31 of the Inland Revenue Act No. 28 of 1979 or", key="act:38/2000")
assert ("cites", "act:28/1979", "31") in r and ("cites", "act:28/1979", "9") not in r, r
r = ls(P + "3. Section 10 of the principal enactment as amended by Act No. 39 of 1983, is hereby amended.", key="act:47/1984")
assert ("cites", "act:39/1983", None) in r and ("cites", "act:39/1983", "10") not in r and ("amends", F, "10") in r, r

assert {("repeals", F, "49"), ("repeals", F, "50")} <= set(ls(P + "Sections 49 and 50 of the principal enactment are hereby repealed."))
assert ("repeals", F, "73A") in ls(P + "Sections 65 to 73A of the principal enactment are hereby repealed.")
assert ("replaces", F, "8") in ls(P + "Section 8 of the principal enactment is hereby repealed and the following section substituted therefor:—")
assert ("replaces", F, "23D") in ls(P + "Section 23d of the principal enactment is hereby repealed and the following substituted therefor:-")
r = ls(P + "The following new sections are hereby inserted immediately after section 16, and shall have effect as sections 16A and 16B of the principal enactment:—")
assert {("inserts", F, "16A"), ("inserts", F, "16B")} <= set(r), r
assert ("inserts", F, "49A") in ls(P + "The following new section is hereby inserted immediately after section 49, and shall take effect as section 49A, of the principal enactment:—")
r = ls(P + "The following new sections are hereby inserted immediately after section 5, and shall have effect as section 5A, section 5B and section 5C, of the principal Act:—")
assert {("inserts", F, "5A"), ("inserts", F, "5B"), ("inserts", F, "5C")} <= set(r), r
assert ("amends", "act:7/1979", "18") in ls("Section 18 of the State Lands (Recovery of Possession) Act, No. 7 of 1979 as amended by Acts, Nos. 58 of 1981 and 29 of 1983 is hereby further amended")
assert ("amends", "constitution", "155C") in ls("Article 155C of the Constitution is hereby amended in paragraph (1) of that Article")
assert ("repeals_act", "cap:158", None) in ls("30. The Weights and Measures Ordinance (Chapter 158) is hereby repealed.")
assert ("replaces", F, "5") in ls(P + "There shall be substituted for section 5 of the principal enactment the following section:—")
assert ("amends_act", F, None) in ls("", lt="AN ACT TO AMEND THE FINANCE ACT, NO. 11 OF 1963")
# citations, with the part named before them; history lists
assert ("cites", "cap:19", "53") in ls("Any person who commits an offence under section 53 of the Penal Code shall ...")
assert ("cites", "act:16/1979", None) in ls("the Universities Act. No. 16 of 1979 shall apply")
assert {("cites", "act:5/1990", None), ("cites", "act:6/1991", None)} <= set(ls("referred to in Acts Nos. 5 of 1990 and 6 of 1991"))
assert ls("Ordinance Nos, 5 of 1890, 3 of 1895 and 7 of 1900.", key="cap:500") == [
    ("consolidates", "ordinance:5/1890", None), ("consolidates", "ordinance:3/1895", None), ("consolidates", "ordinance:7/1900", None)]
print("ok refs")
assert ("cites", "constitution", "154") in ls("(3) The provisions of Article 154 of the Constitution relating to the audit of the accounts shall apply.")
assert ("cites", "constitution", "Chapter XVIIA") in ls("“Provincial Council” means a Provincial Council established by Chapter XVIIA of the Constitution;")
assert ("cites", F, "32") in ls(P + "(2) The amendment made in section 32 of the principal Act by sub-section (1) of this section shall be deemed to have come into force on April 1, 1964.")
assert ("amends_act", "cap:101", None) in ls("AN ACT TO AMEND THE CIVIL PROCEDURE CODE (CHAPTER 101)", lt="AN ACT TO AMEND THE CIVIL PROCEDURE CODE (CHAPTER 101)") or ("cites", "cap:101", None) in ls("AN ACT TO AMEND THE CIVIL PROCEDURE CODE (CHAPTER 101)")
assert ("amends_act", F, None) in ls(P + "(1) In the principal enactment and in any other written law, there shall be substituted for the words “Registrar” the words “Registrar-General”.")
assert ("amends", F, "49") in ls(P + "*Amendment to section 49 of the principal enactment.*")
print("ok refs coverage")
assert ("cites", F, None) in ls(P + "The amendment made to the principal enactment by section 2 of this Act shall be deemed for all purposes to have come into operation on November 12, 1979.")
print("ok refs principal mention")
assert ("cites", "act:15/1979", "303") in ls("Section 303 of the Code of Criminal Procedure Act, Amendment of No. 15 of 1979 (hereinafter referred to as")
assert ("cites", "ordinance:1/1898", None) in ls("Widow’s and Orphan’s Pension Fund Ordinance (Chp. 431) No. 01 of 1898 and subsequent amendments")
assert ("cites", "ordinance:23/1927", None) in ls("[* Repealed by Ordinance No- 23 of 1927.]")
assert ("consolidates", "ordinance:23/1912", None) in ls("AN ORDINANCE FOR THE REGULATION OF CHAUFFEURS. No. 23 of 1912. [9 th September, 1912.]", key="cap:172")
assert not [x for x in ls("published as Treaty Series No. 5 of 1964", key="cap:500") if "1964" in x[1]]
print("ok refs bare")

# year guard: a number passed after the citing law gives way to the name printed with it (law:30/1978)
graph.TITLES.update({"inland revenue": "act:4/1963"})
r = links("law:30/1978", "", ["2. Section 2 of the Inland Revenue Act, No. 4 of 1983 (hereinafter referred to as the “principal enactment”) is hereby amended.\n\n3. Section 97 of the principal enactment is hereby amended."])
assert {x[2] for x in r if x[1] == "amends"} == {"act:4/1963"}, r
u = []
assert not [x for x in links("law:5/1976", "", ["Section 3 of Law No. 48 of 1978 is hereby amended."], u) if x[1] == "amends"] and u, u
print("ok refs year guard")
assert ("cites", "cap:19", None) in ls("the Penal Code (Chapter 19)", key="act:1/1964")       # a 1980 chapter is not "a 1980 law"
print("ok refs chapters undated")

# issue #9: repeals_act only for the whole law; a part's repeal is the part
for s in ("Section 5 of the principal enactment is hereby repealed.", "Sections 52 to 74 of the principal enactment are hereby repealed.",
          "Part IX of the principal enactment is hereby repealed.", "Chapter XIX of the principal enactment is hereby repealed.",
          "So much of the Finance Act, No. 11 of 1963 as relates to licences is hereby repealed."):
    assert not [x for x in ls(P + s) if x[0].endswith("_act")], (s, ls(P + s))
assert ("repeals", F, "Chapter XIX") in ls(P + "Chapter XIX of the principal enactment is hereby repealed.")
assert ("repeals", F, "74") in ls(P + "Sections 52 to 74 of the principal enactment are hereby repealed.")
assert ("amends_act", F, None) in ls("", lt="AN ACT TO REPEAL PART IX OF THE FINANCE ACT, NO. 11 OF 1963")
assert ("repeals_act", F, None) in ls("", lt="AN ACT TO REPEAL THE FINANCE ACT, NO. 11 OF 1963")
print("ok refs whole repeals")
for s in ("The long title to the Finance Act, No. 11 of 1963 is hereby repealed.", "Part II and Part III of the Finance Act, No. 11 of 1963, are hereby repealed.",
          "The Second Schedule to the principal enactment as last amended by Act, No. 11 of 1963, is hereby repealed.",
          "means any person registered under the Finance Act, No. 11 of 1963.’. 16. Section 26 of the principal Act is hereby repealed."):
    assert not [x for x in ls(s) if x[0].endswith("_act")], (s, ls(s))
r = ls("PART VIII REPEALS AND TRANSITIONAL PROVISIONS 43. (1) The Natural Resources Energy and Science Authority of Sri Lanka Act, No. 78 of 1981 is hereby repealed.")
assert ("repeals_act", "act:78/1981", None) in r and not [x for x in r if x[0] == "repeals"], r
r = ls(P + "Part IXA (sections 801 to 833R both inclusive) of the principal enactment is hereby repealed.")
assert {("repeals", F, "Part IXA"), ("repeals", F, "801"), ("repeals", F, "833R")} <= set(r), r
print("ok refs part repeals")
for s in ("The Finance Act, No. 11 of 1963, shall not apply to any year after 1963. (3) The Double Taxation Act is hereby repealed.",
          "Subsection (2) is repealed by Act No. 11 of 1963. ^ Subsections (4) and (5) are repealed",
          "Schedules ‘A’, ‘B’ and ‘C’ of the Finance Act, No. 11 of 1963 are hereby repealed."):
    assert not [x for x in ls(s) if x[0] == "repeals_act" and x[1] == F], (s, ls(s))
r = ls("Chapter VIIA of the Constitution (Articles 41A to 41H) is hereby repealed.")
assert {("repeals", "constitution", "Chapter VIIA"), ("repeals", "constitution", "41A"), ("repeals", "constitution", "41H")} <= set(r), r
print("ok refs gaps")
r = ls("Chapters II and IV of the Finance Act, No. 11 of 1963, are hereby repealed.")
assert {("repeals", F, "Chapter II"), ("repeals", F, "Chapter IV")} <= set(r) and not [x for x in r if x[0].endswith("_act")], r
assert not [x for x in ls("The sections of the Finance Act, No. 11 of 1963 specified in Column I are hereby amended.") if x[0].endswith("_act")]
print("ok refs chapters list")
assert not [x for x in ls("23. Table ‘A’, Table ‘B’ and Table ‘C’ of the Finance Act, No. 11 of 1963 are hereby repealed and the following tables are substituted therefor") if x[0].endswith("_act")]
print("ok refs tables")
