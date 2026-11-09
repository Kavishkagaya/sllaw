"""python3 -m etl.test_mentions -- citations as mentions (etl/mentions.py, docs/LINKS.md), on sentences from the corpus."""
from etl import graph
from etl.mentions import kind_of, mentions

graph.CHAPTERS.update({"penal code": "cap:19", "land acquisition": "cap:460", "turnover tax": "act:69/1981"})


def ms(text, key="act:5/2010", lt=""):
    return [(kind_of(r), r["dst_doc"], tuple(r["labels"]), r["law_form"]) for r in mentions(key, lt, [text])]


P = "2. Section 2 of the Finance Act, No. 11 of 1963 (hereinafter referred to as the “principal enactment”) is hereby amended.\n\n"
F = "act:11/1963"
# a section amendment gives one mention, no amends_act copy and no cites copy of the same section
r = ms(P + "3. Section 97 of the principal enactment is hereby amended as follows:—")
assert ("amends", F, ("97",), "principal") in r and not any(k in ("amends_act", "cites") and d == F and l in ((), ("97",)) for k, d, l, _ in r), r
# "that Act" / "the said Act": the law named before it, not the principal enactment
r = ms("acquired under the Land Acquisition Act, No. 9 of 1950: Provided that, notwithstanding anything in that Act, "
       "the compensation under section 7 of the said Act shall be paid.", key="act:1/1958")
assert ("cites", "act:9/1950", ("7",), "anaphora") in r and ("cites", "act:9/1950", (), "anaphora") in r, r
# an anaphora after a law we cannot resolve gives nothing rather than an older law
r = ms("the Lanka Trees Board Ordinance shall apply, and the meaning in that Ordinance; the Excise Ordinance No. 8 of 1912.", key="act:5/1960")
assert not any(f == "anaphora" for *_, f in r), r
# a same-law section: "under section 12", "section 14 of this Act"; "or" lists; not the law's own heading
r = ms("12. Any person who contravenes section 5 or section 6 (2) (a) shall be guilty of an offence under this Act. "
       "A notice under section 14 of this Act. Section 12. Dividends")
assert ("cites", "act:5/2010", ("5", "6"), "this_law") in r and ("cites", "act:5/2010", ("14",), "this_law") in r, r
assert ("cites", "act:5/2010", ("12",), "this_law") not in r, r
# in an amending law a bare section is the principal enactment's
r = ms(P + "4. Section 5 of the principal enactment is amended in subsection (2) of section 12, by the substitution",
       key="act:2/2011", lt="AN ACT TO AMEND THE FINANCE ACT, No. 11 OF 1963")
assert ("cites", F, ("12",), "principal") in r, r
# Constitution: Articles, "of Constitution", amendments with their section
r = ms("Substituted by the Fourteenth Amendment to the Constitution Sec. 2(a). Renumbered by Section 2(b) of the "
       "Thirteenth Amendment to the Constitution. Article 154 of Constitution", key="act:7/2024")
assert ("cites", "amendment:14", ("2",), "amendment") in r and ("cites", "amendment:13", ("2",), "amendment") in r, r
assert ("cites", "constitution", ("154",), "constitution") in r, r
# Statutes, gazette lists, old gazettes, format slips
r = ms("Western Province Sports Statute, No. 01 of 1993; Gazette Notifications No. 1681/5 of 22.11.2010 and 1686/43; "
       "Gazette No. 10,132 of August 1, 1950; the Industrial Disputes Act, (Chapter. 131); Disaster Management Act No.13/2005; "
       "Agricultural Products Act, No. 33, of 1961", key="gazette:1702/19")
assert any(f == "statute" for *_, f in r) and ("cites", "gazette:1686/43", (), "gazette") in r, r
assert ("cites", "gazette:10132", (), "gazette") in r and ("cites", "act:13/2005", (), "number") in r, r
assert ("cites", "act:33/1961", (), "number") in r and any(d == "chapter:131" for _, d, _, _ in r), r
# "section 27 A (1)" is 27A; "part is formed" is no Part; a tariff "Chapter 46" in a gazette is no law
r = ms("under section 27 A (1) of the Land Reform Act, No. 1 of 1972. the working part is formed by Note 1. Chapter 46 Manufactures of straw",
       key="gazette:2017/02")
assert ("made_under", "act:1/1972", ("27A",), "number") in r and not any(d == "chapter:46" for _, d, _, _ in r), r
assert not any(l and l[0].startswith("Part") for _, _, l, _ in r), r
# a defined short name; generic "the law" / "that law" are not laws
r = ms("the Code of Criminal Procedure Act, No. 15 of 1979 (hereinafter referred to as “the Code”). An appeal under "
       "section 320 of the Code. the provisions of that law shall remain suspended under the law for the time being.", key="act:9/1990")
assert ("cites", "act:15/1979", ("320",), "defined") in r and not any(d is None for _, d, _, _ in r), r
# a Part repealed with its sections keeps both; a made_under through "(Chapter 40)"
r = ms("3. Chapter IV of the principal enactment (sections 16 to 24 both inclusive) is hereby repealed.", key="act:18/2024",
       lt="AN ACT TO AMEND THE CIVIL PROCEDURE CODE (CHAPTER 101)")
assert any(k == "repeals" and "Chapter IV" in l and "16" in l for k, _, l, _ in r), r
r = ms("BY virtue of the powers vested in me by Section 12 of the Public Security Ordinance (Chapter 40), I do", key="gazette:1635/24")
assert any(k == "made_under" and l == ("12",) for k, _, l, _ in r), r
print("test_mentions: all passed")
