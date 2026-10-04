"""
Structure Library — Sri Lanka Legal Acts
=========================================
Canonical schema for the document objects produced by stage2 / build_document.

Grounded in corpus analysis of four acts:
  Act 46/2000  Agrarian Development Act         84 pp    95 sections   8 parts
  Act 14/2010  Civil Aviation Act               99 pp   128 sections  11 parts
  Act 36/2003  Intellectual Property Act       163 pp   213 sections  11 parts
  Act 19/2018  National Audit Act               47 pp    56 sections   9 parts

Content types
-------------
✓ Cover metadata       — title, number, year, certified date
✓ Section              — numbered body section with marginal note
✓ Schedule             — post-section block (FIRST SCHEDULE / SCHEDULE I / FORM A / TABLE A)
✗ Part / Chapter       — structural grouping of sections  (schema not yet locked)
✗ Appendix             — non-text pages (tables / forms) that were not named schedules

doc_json top-level keys
-----------------------
  title, number, year, certified  — cover metadata
  parts      — list of part/chapter objects
  sections   — dict keyed by str(section_number); "/" key means collision
  schedules  — list of schedule objects, in document order
  appendices — list of raw text chunks from non-text pages
  flags      — list of flag strings recorded during extraction
  stopped    — bool; True means extraction halted on an unhandled pattern

Section dict key rules
----------------------
  Normal     "47"        — unique section number across the whole act
  Collision  "XXIII/1"   — same number reused across parts; both kept, collision flagged
  A clean key-set (no "/" keys) means all section numbers were globally unique.
"""

from __future__ import annotations

from typing import Any


# ── Leaf nodes ────────────────────────────────────────────────────────────────

class SubItem:
    """
    Roman-numeral list sub-item inside a ListItem.
    Label format: "(i)", "(ii)", "(iii)", ...
    Always terminal — no children observed below this level.
    """
    __slots__ = ("label", "text")

    def __init__(self, label: str, text: str) -> None:
        self.label = label
        self.text  = text


class ListItem:
    """
    Alphabetic list item.
    Label format: "(a)", "(b)", "(c)", ...
    May contain SubItems (roman-numeral level).
    """
    __slots__ = ("label", "text", "sub_items")

    def __init__(self, label: str, text: str, sub_items: list[SubItem] | None = None) -> None:
        self.label     = label
        self.text      = text
        self.sub_items = sub_items or []


# ── Body node types ───────────────────────────────────────────────────────────

class TextNode:
    """
    Plain paragraph text — body prose, cross-references, definitions.
    type = "text"
    """
    type = "text"
    __slots__ = ("text",)

    def __init__(self, text: str) -> None:
        self.text = text


class Subsection:
    """
    Numbered subsection — (1), (2), (3), ...
    type = "subsection"

    Most common body node type (287–433 per act).
    .items holds the flat list of ListItems nested inside this subsection.
    When items is empty, .text holds all the subsection prose.

    Nesting ceiling (observed): subsection → list_item → sub_item (3 levels).
    """
    type = "subsection"
    __slots__ = ("number", "text", "items")

    def __init__(self, number: str, text: str, items: list[ListItem] | None = None) -> None:
        self.number = number   # "1", "2", ...
        self.text   = text
        self.items  = items or []


class Proviso:
    """
    Proviso clause — starts with "Provided" or "Provided however,".
    type = "proviso"

    Always directly in the section body, not nested inside a subsection.
    """
    type = "proviso"
    __slots__ = ("text",)

    def __init__(self, text: str) -> None:
        self.text = text


class ChapterHeader:
    """
    Chapter heading embedded inside a section body.
    type = "chapter_header"

    Observed only in the Intellectual Property Act (36/2003), where CHAPTER
    headings appear as the first element of the first section in that chapter.
    .title may be empty string when the chapter title was not parsed separately.
    """
    type = "chapter_header"
    __slots__ = ("number", "title")

    def __init__(self, number: str, title: str = "") -> None:
        self.number = number   # roman numeral: "I", "II", ...
        self.title  = title


# ── Section ───────────────────────────────────────────────────────────────────

class Section:
    """
    One numbered section of an act.

    .number       — integer section number (1-based, dict key is str(number))
    .short_title  — marginal note printed in the left column next to this section,
                    e.g. "Short title.", "Powers of the Commissioner."
                    None only when the PDF had no marginal column or the note
                    was not matched spatially.  For well-formed PDFs this is
                    almost always populated.
    .part         — roman-numeral identifier of the enclosing PART, or None for
                    preamble sections (short title, interpretation) before Part I.
    .body         — ordered list of body nodes (see types above)

    Body node type inventory (confirmed across 492 sections, 4 acts):
      text          plain paragraph / definition text
      subsection    (1)(2)…  with optional nested .items
      list_item     (a)(b)…  with optional nested .sub_items
      sub_item      (i)(ii)… terminal; occasionally unattached at body level
      proviso       "Provided that …"
      chapter_header  embedded CHAPTER heading (IP Act only)

    Known anomalies:
      - Sections 69-74 silently absent in Agrarian Act (46/2000): those sections
        appear on non-text pages (tables/forms) and were not extracted.  The dict
        has a gap; no flag is raised.  Corpus gap, not a collision.
      - sub_item at body level means the parser could not attach it to a parent
        list_item; this is a known parser limitation.
    """
    __slots__ = ("number", "short_title", "part", "body")

    def __init__(
        self,
        number:      int,
        short_title: str | None,
        part:        str | None,
        body:        list,
    ) -> None:
        self.number      = number
        self.short_title = short_title   # marginal note
        self.part        = part
        self.body        = body


# ── Schedule ──────────────────────────────────────────────────────────────────

class Schedule:
    """
    A named schedule / form / table block appearing after the main sections.

    Schedules are visually similar to sections (heading + content) but are NOT
    numbered sections — they are never part of the sections dict.  They are
    collected in the top-level "schedules" list in document order.

    .name     — the heading text as printed: "FIRST SCHEDULE", "SCHEDULE I",
                "TABLE A", "FORM 1", etc.  Matched by RE_SCHEDULE in classify().
    .content  — list of text strings extracted from the schedule body, in order.
                May be sparse or raw when schedule pages are non-text (tables,
                images) — docling extracts what it can from the PDF cells.

    Observed patterns across corpus:
      Agrarian Act (46/2000)  : 0 schedules  (forms/tables on non-text pages →
                                              they went to appendices, not here)
      Civil Aviation (14/2010): schedules present
      IP Act (36/2003)        : schedules present
      National Audit (19/2018): schedules present

    Known limitation:
      Schedule pages that docling classifies as page_type='other' (tables,
      scanned images) accumulate in 'appendices' instead of here, because page
      type routing happens before schedule-header detection.
    """
    __slots__ = ("name", "content")

    def __init__(self, name: str, content: list[str] | None = None) -> None:
        self.name    = name
        self.content = content or []


# ── Cover metadata ────────────────────────────────────────────────────────────

class CoverMeta:
    """
    Metadata extracted from the first page of the act.

    .title     — act title ALL-CAPS as printed, e.g. "CIVIL AVIATION ACT"
    .number    — act number as integer, e.g. 14
    .year      — year, e.g. 2010
    .certified — raw date string, e.g. "03rd November, 2010"  (format varies)
    """
    __slots__ = ("title", "number", "year", "certified")

    def __init__(self, title: str, number: int, year: int, certified: str | None) -> None:
        self.title     = title
        self.number    = number
        self.year      = year
        self.certified = certified


# ── Validator ─────────────────────────────────────────────────────────────────

class ValidationError:
    __slots__ = ("path", "message")

    def __init__(self, path: str, message: str) -> None:
        self.path    = path
        self.message = message

    def __str__(self) -> str:
        return f"{self.path}: {self.message}"


def _expect_keys(d: dict, required: set[str], path: str, errors: list) -> None:
    for k in required:
        if k not in d:
            errors.append(ValidationError(path, f"missing key '{k}'"))


def _check_sub_item(node: dict, path: str, errors: list) -> None:
    _expect_keys(node, {"label", "text"}, path, errors)
    label = node.get("label", "")
    if not (label.startswith("(") and label.endswith(")")):
        errors.append(ValidationError(path, f"label {label!r} not in (x) form"))


def _check_list_item(node: dict, path: str, errors: list) -> None:
    _expect_keys(node, {"label", "text", "sub_items"}, path, errors)
    for i, sub in enumerate(node.get("sub_items", [])):
        _check_sub_item(sub, f"{path}.sub_items[{i}]", errors)


def _check_body_node(node: dict, path: str, errors: list) -> None:
    t = node.get("type")
    if t is None:
        errors.append(ValidationError(path, "missing 'type'"))
        return

    if t == "text":
        if "text" not in node:
            errors.append(ValidationError(path, "text node missing 'text'"))

    elif t == "subsection":
        _expect_keys(node, {"number", "text", "items"}, path, errors)
        for i, item in enumerate(node.get("items", [])):
            _check_list_item(item, f"{path}.items[{i}]", errors)

    elif t == "list_item":
        _check_list_item(node, path, errors)

    elif t == "sub_item":
        # sub_item at body level = unattached roman item (known parser limit)
        _check_sub_item(node, path, errors)

    elif t == "proviso":
        if "text" not in node:
            errors.append(ValidationError(path, "proviso missing 'text'"))

    elif t == "chapter_header":
        _expect_keys(node, {"number", "title"}, path, errors)

    else:
        errors.append(ValidationError(path, f"unknown node type {t!r}"))


def validate_section(sec: dict[str, Any]) -> list[ValidationError]:
    """
    Validate a single section dict.
    Returns a (possibly empty) list of ValidationErrors.
    """
    errors: list[ValidationError] = []
    root = "section"

    _expect_keys(sec, {"number", "short_title", "part", "body"}, root, errors)

    num = sec.get("number")
    if num is not None and not isinstance(num, int):
        errors.append(ValidationError(root, f"'number' should be int, got {type(num).__name__}"))

    if sec.get("short_title") is None:
        errors.append(ValidationError(root, "marginal note (short_title) is None — check PDF layout"))

    body = sec.get("body")
    if body is None:
        pass
    elif not isinstance(body, list):
        errors.append(ValidationError(root, "'body' should be a list"))
    else:
        for i, node in enumerate(body):
            _check_body_node(node, f"{root}.body[{i}]", errors)

    return errors


def validate_schedule(sched: dict[str, Any], path: str = "schedule") -> list[ValidationError]:
    """Validate a single schedule dict."""
    errors: list[ValidationError] = []
    _expect_keys(sched, {"name", "content"}, path, errors)
    if not sched.get("name"):
        errors.append(ValidationError(path, "schedule name is empty"))
    content = sched.get("content", [])
    if not isinstance(content, list):
        errors.append(ValidationError(path, "'content' should be a list"))
    return errors


def validate_doc(doc: dict[str, Any]) -> list[ValidationError]:
    """
    Validate an entire doc_json object (output of build_document).
    Returns a flat list of ValidationErrors; empty means clean.
    """
    errors: list[ValidationError] = []

    # Cover
    for field in ("title", "number", "year"):
        if doc.get(field) is None:
            errors.append(ValidationError("cover", f"missing '{field}'"))

    # Sections dict
    sections = doc.get("sections", {})
    if not isinstance(sections, dict):
        errors.append(ValidationError("sections", "expected dict"))
        return errors

    int_keys       = []
    collision_keys = []
    for k in sections:
        if "/" in str(k):
            collision_keys.append(k)
        elif str(k).isdigit():
            int_keys.append(int(k))
        else:
            errors.append(ValidationError("sections", f"unexpected key format: {k!r}"))

    if collision_keys:
        errors.append(ValidationError(
            "sections",
            f"{len(collision_keys)} collision key(s): {collision_keys[:5]}",
        ))

    if int_keys:
        int_keys.sort()
        gaps = [n for a, b in zip(int_keys, int_keys[1:]) for n in range(a + 1, b) if b - a > 1]
        if gaps:
            errors.append(ValidationError(
                "sections",
                f"gap in section numbering: {gaps[:10]} (non-text pages or parser miss)",
            ))

    missing_marginal = []
    for k, sec in sections.items():
        sec_errors = validate_section(sec)
        # separate out marginal-note warnings from hard errors
        for e in sec_errors:
            if "marginal note" in e.message:
                missing_marginal.append(k)
            else:
                errors.append(ValidationError(f"sections[{k!r}].{e.path}", e.message))

    if missing_marginal:
        errors.append(ValidationError(
            "sections",
            f"{len(missing_marginal)} section(s) have no marginal note: {missing_marginal[:10]}",
        ))

    # Schedules
    for i, sched in enumerate(doc.get("schedules", [])):
        for e in validate_schedule(sched, f"schedules[{i}]"):
            errors.append(e)

    return errors


# ── CLI audit ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 2:
        print("Usage: structures.py <doc_json_file>")
        sys.exit(1)

    with open(sys.argv[1]) as f:
        doc = json.load(f)

    errs = validate_doc(doc)
    secs  = doc.get("sections", {})
    scheds = doc.get("schedules", [])
    print(f"{doc.get('title')}  No. {doc.get('number')} of {doc.get('year')}")
    print(f"  sections:  {len(secs)}")
    print(f"  schedules: {len(scheds)}" + (
        f"  [{', '.join(s['name'] for s in scheds[:5])}]" if scheds else ""
    ))
    print(f"  pages:     {doc.get('total_pages')}")
    print(f"  flags:     {doc.get('flags', [])}")
    print(f"  stopped:   {doc.get('stopped', False)}")
    if errs:
        print(f"\n  {len(errs)} validation issue(s):")
        for e in errs:
            print(f"    {e}")
    else:
        print("\n  OK — no structural issues")
