"""
structures.py — Consolidated Statutes Schema
=============================================
Canonical schema for documents produced by stage2 / build_document_pdf.

Two source pipelines produce different body shapes:
  HTML  — body is a single flat string (plain text from BeautifulSoup)
  PDF   — body is a list of structured node dicts (same types as acts)

doc_json top-level keys
-----------------------
  title, description, enacted_date, is_repealed  — metadata
  parts      — list of part objects
  sections   — dict keyed by section_number string
  schedules  — list of schedule objects (PDF only)
  flags      — list of flag strings (PDF only)
  stopped    — bool; True means extraction halted on unknown pattern (PDF only)
  source_url — original URL

Section dict (HTML source)
--------------------------
  short_title  str | None  — marginal note from <font class="sectionshorttitle">
  part         str | None  — enclosing part name
  body         str         — flat section text

Section dict (PDF source)
-------------------------
  short_title  str | None  — marginal column text matched by y-overlap
  part         str | None  — enclosing PART heading
  body         list        — structured nodes (same types as acts/structures.py)

Body node types (PDF source — same as acts):
  text          plain paragraph
  subsection    (1)(2)... with optional items list
  list_item     (a)(b)... with optional sub_items list
  sub_item      (i)(ii)... terminal
  proviso       "Provided that ..."
  chapter_header  embedded CHAPTER heading

Known limitations
-----------------
- enacted_date is always None for PDFs (no "Certified on" line in consolidated PDFs)
- Alphanumeric amendment sections (e.g. 1A., 1B.) are absorbed into the preceding
  numeric section's body when docling merges their text cells
- PART headings: PDF renderer drops space ("PARTI"), fixed by regex normalisation
- Schedule pages classified as page_type='other' go to appendices not schedules
"""

from __future__ import annotations

from typing import Any


def validate_section_html(sec: dict[str, Any]) -> list[str]:
    """Validate a section dict from HTML extraction. Returns list of issues."""
    issues = []
    if "short_title" not in sec:
        issues.append("missing short_title")
    if "part" not in sec:
        issues.append("missing part")
    body = sec.get("body")
    if body is None:
        issues.append("missing body")
    elif not isinstance(body, str):
        issues.append(f"body should be str for HTML source, got {type(body).__name__}")
    return issues


def validate_section_pdf(sec: dict[str, Any]) -> list[str]:
    """Validate a section dict from PDF extraction. Returns list of issues."""
    issues = []
    if "short_title" not in sec:
        issues.append("missing short_title")
    elif sec["short_title"] is None:
        issues.append("short_title is None (marginal note not matched)")
    if "part" not in sec:
        issues.append("missing part")
    body = sec.get("body")
    if body is None:
        issues.append("missing body")
    elif not isinstance(body, list):
        issues.append(f"body should be list for PDF source, got {type(body).__name__}")
    return issues


def validate_doc(doc: dict[str, Any]) -> list[str]:
    """Validate a consolidated statute doc_json. Returns flat list of issue strings."""
    issues = []

    if not doc.get("title"):
        issues.append("cover: missing title")

    sections = doc.get("sections", {})
    if not isinstance(sections, dict):
        issues.append("sections: expected dict")
        return issues

    source_is_pdf = isinstance(next(iter(sections.values()), {}).get("body"), list) \
        if sections else False

    missing_marginal = []
    for num_str, sec in sections.items():
        if source_is_pdf:
            errs = validate_section_pdf(sec)
        else:
            errs = validate_section_html(sec)

        for e in errs:
            if "marginal note" in e or "short_title is None" in e:
                missing_marginal.append(num_str)
            else:
                issues.append(f"sections[{num_str!r}]: {e}")

    if missing_marginal:
        issues.append(
            f"sections: {len(missing_marginal)} section(s) missing marginal note: "
            f"{missing_marginal[:10]}"
        )

    for i, sched in enumerate(doc.get("schedules", [])):
        if not sched.get("name"):
            issues.append(f"schedules[{i}]: missing name")

    if doc.get("stopped"):
        issues.append(f"stopped=True  flags={doc.get('flags', [])[:3]}")

    return issues


# ── CLI audit ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 2:
        print("Usage: structures.py <doc_json_file>")
        sys.exit(1)

    with open(sys.argv[1]) as f:
        doc = json.load(f)

    secs   = doc.get("sections", {})
    scheds = doc.get("schedules", [])
    print(f"{doc.get('title')}  ({doc.get('enacted_date')})")
    print(f"  sections:  {len(secs)}")
    print(f"  schedules: {len(scheds)}" + (
        f"  [{', '.join(s['name'] for s in scheds[:5])}]" if scheds else ""
    ))
    print(f"  flags:     {doc.get('flags', [])}")
    print(f"  stopped:   {doc.get('stopped', False)}")

    errs = validate_doc(doc)
    if errs:
        print(f"\n  {len(errs)} issue(s):")
        for e in errs:
            print(f"    {e}")
    else:
        print("\n  OK — no structural issues")
