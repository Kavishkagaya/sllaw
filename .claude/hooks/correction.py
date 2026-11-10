#!/usr/bin/env python3
"""UserPromptSubmit: when the user's message reads like a correction, remind the agent of the learning loop
(CLAUDE.md, "When something goes wrong"). It only adds a reminder; the agent decides whether it is a correction."""
import json
import re
import sys

SIGNS = r"\b(never|don'?t|do not|stop|wrong|why did you|why do you|i said|i told you|again|not like that|always|" \
        r"should not|shouldn'?t|mistake|instead of)\b"

prompt = json.load(sys.stdin).get("prompt", "")
if re.search(SIGNS, prompt, re.I):
    print("If this message corrects how you worked: fix it, then before the turn ends close the loop (CLAUDE.md, "
          "\"When something goes wrong\"): a guard in .claude/hooks/guard.py if a machine can check it, else one "
          "dated line in CLAUDE.md \"Rules\"; tell the user in one line what changed. Not a correction: ignore this.")
