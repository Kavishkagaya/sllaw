"""Per-type profiles for the generic structure finder (docs/PIPELINE_V2.md, stage 4): data, not code branches.

unit      the word for a numbered provision (the label's kind in a breadcrumb)
headings  Part/Chapter headings open scopes (off for amending laws: they quote other laws' Parts)
notes     marginal notes are printed (a unit without one is worth a flag)
gazette   the masthead, running heads and the second column handled as a gazette's (etl.docs.gazette_body)
"""

KIND = {"act": "act", "law": "law", "ordinance": "ordinance", "cap": "chapter1980", "cap1956": "chapter1956",
        "amendment": "amendment", "constitution": "constitution", "gazette": "gazette"}

BASE = {
    "act": {"unit": "section", "headings": True, "notes": True},
    "law": {"unit": "section", "headings": True, "notes": True},
    "ordinance": {"unit": "section", "headings": True, "notes": True},
    "chapter1980": {"unit": "section", "headings": True, "notes": True},
    "chapter1956": {"unit": "section", "headings": True, "notes": True},
    "amendment": {"unit": "section", "headings": True, "notes": True},
    "constitution": {"unit": "Article", "headings": True, "notes": True},
    # a gazette can hold several instruments (by-laws), each numbered from 1, and regulations restart under a Part
    "gazette": {"unit": "regulation", "headings": True, "notes": False, "gazette": True, "restarts": True},
}


def kind_of(key):
    return KIND.get(key.split(":")[0], "other")


def profile(key, title):
    """The profile for one document. An amending law ("... (Amendment) Act") quotes the Parts of the law it amends,
    so its own headings are not scopes (etl.docs.build_one, parts=False)."""
    kind = kind_of(key)
    p = {"kind": kind, **BASE.get(kind, BASE["act"])}
    if "AMENDMENT" in (title or "").upper() and kind != "constitution":
        p["headings"], p["amending"] = False, True
    return p
