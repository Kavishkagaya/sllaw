#!/usr/bin/env python3
"""SessionStart: show the agent the open work (briefs not merged or dropped) and the last progress note of each,
so a new session picks up where the last one stopped (CLAUDE.md, "The loop")."""
import json
import os
import subprocess

top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip() or "."
branch = subprocess.run(["git", "branch", "--show-current"], capture_output=True, text=True).stdout.strip()
feats = os.path.join(top, "docs", "features")
lines = []
for name in sorted(os.listdir(feats)) if os.path.isdir(feats) else []:
    if not name.endswith(".json"):
        continue
    try:
        with open(os.path.join(feats, name)) as f:
            b = json.load(f)
    except (OSError, ValueError):
        continue
    nb = b.get("neon_branch") or {}
    if b.get("status") in ("merged", "dropped"):
        if nb.get("id"):
            lines.append(f"- LEFTOVER: {name} is {b.get('status')} but its Neon branch {nb.get('name')} ({nb['id']}) "
                         "still exists: delete it (Neon delete_branch) and set neon_branch to null.")
        continue
    last = (b.get("progress") or [{}])[-1]
    here = " (this branch)" if b.get("branch") == branch else ""
    lines.append(f"- {name}: {b.get('status')}, branch {b.get('branch')}{here}, issue #{b.get('issue') or '-'}; "
                 f"last: {last.get('date', '')} {last.get('note', 'nothing yet')}")
if lines:
    print("Open work (docs/features). Agreed briefs continue with /build; scoping ones with /scope:\n" + "\n".join(lines))
else:
    print("No open work in docs/features. A new feature starts with /scope (scoping with the user, before any code).")
