#!/usr/bin/env python3
"""PreToolUse guard: the repo's rules that a machine can check (CLAUDE.md, "Rules").

Each rule is one function: it gets the tool call and returns None (fine) or (decision, reason), where decision is
"deny" (never do this) or "ask" (only with the user's yes). A correction from the user that can be checked becomes a
new rule here, with the date it was given. Test: python3 .claude/hooks/test_guard.py
"""
import json
import os
import re
import subprocess
import sys

def has(cmd, pattern):
    return re.search(pattern, cmd) is not None


# ---- Bash rules -------------------------------------------------------------------------------------------------

def merge_rebase(cmd):
    # 2026-10-26: sllaw PRs merge with "Rebase and merge" only, for a linear main.
    if has(cmd, r"\bgh\s+pr\s+merge\b") and "--rebase" not in cmd:
        return "deny", "PRs merge with `gh pr merge <n> --rebase` only (rule: linear main)."


def headed_browser(cmd):
    # 2026-10-27: browser tests run headed; the user watches them (and Clerk blocks headless sign-up).
    if has(cmd, r"\bagent-browser\b.*\bopen\b") and "--headed" not in cmd:
        return "deny", "Browser tests run headed: add `--headed` to `agent-browser ... open`."


DOWNLOADS = [
    r"\b(pip|pip3|uv\s+pip)\s+install\b",
    r"\buv\s+add\b",
    r"\b(pnpm|npm|yarn)\s+(add|install)\s+(-\S+\s+)*[^-\s]",  # adding a package; plain `pnpm install` is fine
    r"\bhuggingface-cli\s+download\b",
    r"\bhf\s+download\b",
    r"\bsnapshot_download\b",
    r"\bwget\s",
    r"\bcurl\b[^|;&]*\s-(o|O|-output|-remote-name)\b",
    r"\bgit\s+lfs\s+pull\b",
]


def downloads(cmd):
    # 2026-10-04 (nothing downloaded to this machine) and 2026-10-09 (no model or package download without a yes).
    for p in DOWNLOADS:
        if has(cmd, p):
            return "ask", ("This downloads or installs something. Rule: no downloads without the user's yes; say what, "
                           "how big and where. Source files never come to this machine (heavy work goes to ampere).")


def production_writes(cmd):
    # Writes to shared production systems (kb, Zilliz, R2) need the user's go-ahead (PIPELINE_V2 deploy checklist).
    if has(cmd, r"\betl\.v2\.run\b") and "--apply" in cmd:
        return "ask", "`--apply` writes production (kb in Neon, Zilliz or R2). Needs the user's go-ahead."
    if has(cmd, r"\betl\.(publish|embed)\b") or has(cmd, r"\betl/(publish|embed)\.py\b"):
        return "ask", "v1 publish/embed writes shared systems and is retired since 2026-11-08 (v2 does it)."


def no_worktree(cmd):
    # user, 2026-11-11: brief branches are checked out in ~/sllaw itself, never a separate worktree.
    if has(cmd, r"\bgit\s+(-C\s+\S+\s+)?worktree\s+add\b"):
        return "deny", "No worktrees: `git checkout -b app/<slug> origin/main` here in ~/sllaw (CLAUDE.md, Branches)."


def force_push(cmd):
    if has(cmd, r"\bgit\s+push\b") and (has(cmd, r"\s(-f|--force)(\s|$)") or "--force-with-lease" in cmd):
        return "ask", "Force push rewrites shared history. Needs the user's yes."


def commit_checks(cmd, cwd):
    # A commit is "done" only when the checks pass: app (biome on staged files, typecheck, unit tests), etl (tests).
    if not has(cmd, r"\bgit\b(\s+-C\s+\S+)?\s+commit\b"):
        return None
    m = re.search(r"\bgit\s+-C\s+(\S+)", cmd)
    where = os.path.join(cwd, m.group(1)) if m else cwd
    git = ["git", "-C", where]
    try:
        top = subprocess.run(git + ["rev-parse", "--show-toplevel"], capture_output=True, text=True,
                             check=True).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    files = subprocess.run(git + ["diff", "--cached", "--name-only"], capture_output=True, text=True).stdout.split()
    if has(cmd, r"\s(-a|--all|-am)\b"):
        files += subprocess.run(git + ["diff", "--name-only"], capture_output=True, text=True).stdout.split()
    fails = []

    def run(name, argv, cwd_):
        r = subprocess.run(argv, cwd=cwd_, capture_output=True, text=True, timeout=280)
        if r.returncode != 0:
            out = (r.stdout + r.stderr).strip().splitlines()
            fails.append(f"{name} failed:\n" + "\n".join(out[-25:]))

    app = os.path.join(top, "app")
    if any(f.startswith("app/") for f in files) and os.path.isdir(os.path.join(app, "node_modules")):
        run("biome (staged)", ["pnpm", "exec", "biome", "check", "--staged", "--no-errors-on-unmatched",
                               "--diagnostic-level=error"], app)
        run("typecheck", ["pnpm", "-s", "typecheck"], app)
        run("unit tests", ["pnpm", "-s", "test"], app)
    py = os.path.join(top, ".venv", "bin", "python3")
    if any(f.startswith("etl/") and f.endswith(".py") for f in files) and os.path.exists(py):
        for t in ["etl.test_structure", "etl.test_refs", "etl.test_mentions", "etl.v2.test_v2"]:
            run(t, [py, "-m", t], top)
    if fails:
        return "deny", "Checks failed, so this is not done yet. Fix, then commit again.\n\n" + "\n\n".join(fails)


VALIDATORS = ("semantic", "security")


def git_out(where, *args):
    r = subprocess.run(["git", "-C", where, *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def release_gate(cmd, cwd):
    # 2026-11-10 (user): nothing goes out (PR, merge, push to main, production deploy) until the semantic and security
    # validators both passed on that exact commit. Reports: <git-common-dir>/validation/<sha>/<validator>.md (/validate).
    m = re.search(r"\bgit\s+-C\s+(\S+)", cmd)
    where = os.path.join(cwd, m.group(1)) if m else cwd
    rev = "HEAD"
    if has(cmd, r"\bgh\s+pr\s+create\b"):
        what = "opening a PR"
    elif has(cmd, r"\bgh\s+pr\s+merge\b"):
        what = "merging a PR"
        m = re.search(r"--match-head-commit[\s=](\S+)", cmd)
        if not m:
            return "deny", "Merge with `--match-head-commit <full sha>`, so the commit merged is the one validated."
        rev = m.group(1)
    elif has(cmd, r"\bgit\b.*\bpush\b.*\s(\S+:)?(refs/heads/)?main(\s|$)"):
        what = "pushing to main"
        m = re.search(r"\s(\S+):(refs/heads/)?main(\s|$)", cmd)
        if m and m.group(1) not in ("+", ""):
            rev = m.group(1).lstrip("+")
    elif has(cmd, r"\bvercel\b.*--prod\b"):
        what = "a production deploy"
    else:
        return None
    sha = git_out(where, "rev-parse", "--verify", "--quiet", rev + "^{commit}")
    common = git_out(where, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if not sha or not common:
        return "deny", f"Could not resolve {rev} in {where} to check its validation. Fetch it first."
    base = git_out(where, "merge-base", "origin/main", sha) or sha
    files = (git_out(where, "diff", "--name-only", base, sha) or "").split()
    if not files or all(f.endswith(".md") or f.startswith("docs/") for f in files):
        return None  # nothing new, or only docs and briefs: no feature to validate
    missing = []
    for v in VALIDATORS:
        path = os.path.join(common, "validation", sha, v + ".md")
        try:
            with open(path) as f:
                first = f.readline().strip()
        except OSError:
            missing.append(f"{v}: no report")
            continue
        if first != "VERDICT: PASS":
            missing.append(f"{v}: {first or 'empty report'}")
    if missing:
        return "deny", (f"Not validated, so {what} is refused for {sha[:12]}: " + "; ".join(missing) +
                        ". Run /validate (both validators on this commit), fix what fails, then try again.")


# ---- Agent databases ---------------------------------------------------------------------------------------------
# 2026-11-10 (user): the app's database is also production, so each brief gets its own Neon branch of sllaw-app
# (`agent/<slug>`), its worktree's .env.local points at it, and it is deleted at merge or drop. A production migration
# needs the user's yes on the prompt, just before the merge.

AGENT_DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "agent-db.json")
RUNS_APP = r"\bpnpm\b.*\b(dev|start|eval-chat|eval-agent|eval|check-accounts|check-cases|check-files|tool)\b|\bnext\s+(dev|start)\b"
MIGRATES = r"\bdrizzle-kit\s+(push|migrate)\b|@sllaw/db\s+migrate\b|\bpnpm\b.*\bmigrate\b"


def agent_db():
    try:
        with open(AGENT_DB) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def db_url_of(top):
    try:
        with open(os.path.join(top, "app", "apps", "web", ".env.local")) as f:
            for line in f:
                if line.startswith("DATABASE_URL="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return ""


def app_db(cmd, cwd):
    runs, migrates = has(cmd, RUNS_APP), has(cmd, MIGRATES)
    if not (runs or migrates):
        return None
    cfg = agent_db()
    if not cfg:
        return None
    m = re.match(r"\s*cd\s+(\S+)\s*&&", cmd) or re.search(r"\b(?:-C|--dir)\s+(\S+)", cmd)
    where = os.path.join(cwd, os.path.expanduser(m.group(1))) if m else cwd
    top = git_out(where, "rev-parse", "--show-toplevel") if os.path.isdir(where) else None
    if not top:
        return None
    inline = re.search(r"\bDATABASE_URL=(\S+)", cmd)
    url = inline.group(1) if inline else db_url_of(top)
    prod = cfg["main_endpoint"] in url
    branch = git_out(top, "branch", "--show-current") or ""
    if prod and branch != "main":
        return "deny", (f"This worktree ({branch or 'detached'}) points at the production database "
                        f"({cfg['neon_project']} main). Agents test on their brief's Neon branch: create "
                        f"`{cfg['branch_prefix']}<slug>` from main and put its URL in app/apps/web/.env.local (/scope).")
    if prod and migrates:
        return "ask", ("PRODUCTION migration on the app database (dev and production are one database): it is live at "
                       "once. Yes only right before merging the feature that needs it.")
    return None


def neon_branch_ops(tool, inp):
    cfg = agent_db() or {}
    bid = inp.get("branch_id", "")
    if tool.endswith("__delete_project"):
        return "deny", "Projects are never deleted by an agent."
    if tool.endswith(("__delete_branch", "__reset_from_parent")) and bid and bid == cfg.get("main_branch_id"):
        return "deny", "That is the app's main (production) branch."
    return None  # agent branches are deleted at merge or drop (user, 2026-11-10); Neon refuses the default branch


# ---- Agent rules ------------------------------------------------------------------------------------------------

def agent_model(tool, inp):
    """A subagent runs on the cheapest model that can do its job (user, 2026-11-11): every spawn names one, unless
    its definition in .claude/agents/ already sets it. A fork inherits this session's model by design."""
    if tool != "Agent" or inp.get("model"):
        return None
    kind = inp.get("subagent_type") or "general-purpose"
    if kind == "fork":
        return None
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agents", f"{kind}.md")
    try:
        head = open(path).read().split("---")[1]
        if re.search(r"^model:\s*\S", head, re.M):
            return None
    except (OSError, IndexError):
        pass
    return "deny", ("Name the cheapest model that can do this job (haiku for search, reading, summaries; sonnet for "
                    "ordinary code; opus only for hard judgement) in `model`, and say why in one line.")


# ---- MCP rules --------------------------------------------------------------------------------------------------

def neon_sql(tool, inp):
    # 2026-10-10: Neon's egress quota was hit by bulk reads; 2026-10-16: tests don't go to the app's Neon.
    if tool.startswith("mcp__claude_ai_Neon__run_sql"):
        bid = inp.get("branch_id")
        if bid and bid != (agent_db() or {}).get("main_branch_id") and inp.get("project_id") == (agent_db() or {}).get("project_id"):
            return None  # an agent's own branch of the app database
        return "ask", ("SQL on Neon. Rules: small rows only, never bulk doc/chunk text (egress quota); joins stay in "
                       "the database; ETL inspection reads the ETL state DB, never the app's database.")


BRIEF_PATH = r"docs/features/[^/\s'\"]+\.json"
Q = r"['\"]"


def brief_targets(cmd):
    """Does the command write to a brief? The brief must be the target of the write, not merely mentioned (a doc may
    quote a brief's path)."""
    direct = [
        r"open\(\s*" + Q + r"[^'\"]*" + BRIEF_PATH + Q + r"[^)]*" + Q + r"[wa]\+?" + Q,  # open('docs/features/x.json', 'w')
        r"\bsed\s+(-\S+\s+)*-i\b[^|;&]*" + BRIEF_PATH,
        r"\btee\b[^|;&]*" + BRIEF_PATH,
        r">>?\s*" + Q + r"?\S*" + BRIEF_PATH,
        r"\b(rm|mv|truncate)\b[^|;&]*" + BRIEF_PATH,
        r"Path\(\s*" + Q + r"[^'\"]*" + BRIEF_PATH + Q + r"\s*\)\.write_text",
    ]
    if any(has(cmd, p) for p in direct):
        return True
    # p = 'docs/features/x.json' ... open(p, 'w')
    for var in re.findall(r"\b(\w+)\s*=\s*" + Q + r"[^'\"]*" + BRIEF_PATH + Q, cmd):
        if has(cmd, r"open\(\s*" + re.escape(var) + r"\s*,\s*" + Q + r"[wa]\+?" + Q):
            return True
    return False


def brief_shell(cmd):
    # 2026-11-10 (agent's own slip): a brief set to "agreed" by a python one-liner skipped the user's sign-off,
    # because the brief rules watch only Edit/Write. Reading a brief in the shell is fine; changing it is not.
    # Refined the same day: a docs edit that only quoted a brief's path was refused; now only a write to one is.
    if brief_targets(cmd):
        return "deny", ("Change a brief (docs/features/*.json) with Edit or Write, not the shell, so the guard can ask "
                        "the user for sign-off and keep an agreed scope frozen.")


BASH_RULES = [merge_rebase, no_worktree, headed_browser, downloads, production_writes, force_push, brief_shell]


# ---- Scope rules (file edits) -----------------------------------------------------------------------------------
# 2026-11-10 (user): scope together first, then build. A brief (docs/features/<slug>.json) starts in "scoping"; the
# user's yes on the permission prompt moves it to "agreed"; after that its scope is frozen, and code under app/ or
# etl/ can only be edited on a branch whose brief is agreed. 2026-11-14 (user: "I can't agree to scope till I see the
# result"): a scoping brief with "preview": true (turning it on asks the user) also opens its branch for a preview.

BRIEF = re.compile(r"(^|/)docs/features/[^/]+\.json$")
FROZEN = ("goal", "for_whom", "done_check", "scenarios", "out_of_scope")
STATUSES = ("scoping", "agreed", "merged", "dropped")


def toplevel(path):
    d = os.path.dirname(os.path.abspath(path))
    while d and not os.path.isdir(d):
        d = os.path.dirname(d)
    return git_out(d, "rev-parse", "--show-toplevel") if d else None


def edited_text(tool, inp, old):
    if tool == "Write":
        return inp.get("content", "")
    if old is None:
        return None
    a, b = inp.get("old_string", ""), inp.get("new_string", "")
    return old.replace(a, b) if inp.get("replace_all") else old.replace(a, b, 1)


def brief_edit(tool, inp):
    path = inp.get("file_path", "")
    if tool not in ("Write", "Edit") or not BRIEF.search(path):
        return None
    try:
        with open(path) as f:
            old_text = f.read()
        old = json.loads(old_text)
    except (OSError, ValueError):
        old_text, old = None, None
    try:
        new = json.loads(edited_text(tool, inp, old_text) or "")
    except ValueError:
        return "deny", "A brief must stay valid JSON (docs/features/README.md has the shape)."
    status = new.get("status")
    if status not in STATUSES:
        return "deny", f"Brief status must be one of {', '.join(STATUSES)}."
    if old is None:
        if status != "scoping":
            return "deny", "A new brief starts in status \"scoping\"; the user agrees it on the permission prompt."
        return None
    was = old.get("status")
    if was != "scoping" and any(old.get(k) != new.get(k) for k in FROZEN):
        return "deny", ("This scope was agreed with the user and is frozen (goal, for_whom, done_check, scenarios, "
                        "out_of_scope). To change it, ask the user, then set status back to \"scoping\" first.")
    if new.get("preview") and not old.get("preview"):
        return "ask", f"Build a preview of \"{new.get('title')}\" for the user to see before agreeing its scope?"
    if was == "scoping" and status == "agreed":
        checks = "; ".join(str(c.get("check", c)) for c in new.get("done_check", []))
        return "ask", f"USER SIGN-OFF: agree the scope of \"{new.get('title')}\"? Done when: {checks}"
    if was != "scoping" and status == "scoping":
        return "ask", f"Reopen the agreed scope of \"{new.get('title')}\" for changes? (needs the user's yes)"
    return None


def scope_gate(tool, inp):
    path = inp.get("file_path") or inp.get("notebook_path") or ""
    if tool not in ("Write", "Edit", "NotebookEdit") or not path or path.endswith(".md"):
        return None
    top = toplevel(path)
    if not top:
        return None
    rel = os.path.relpath(os.path.abspath(path), top)
    if not (rel.startswith("app/") or rel.startswith("etl/")):
        return None
    branch = git_out(top, "branch", "--show-current") or "(detached)"
    feats = os.path.join(top, "docs", "features")
    for name in sorted(os.listdir(feats)) if os.path.isdir(feats) else []:
        if name.endswith(".json"):
            try:
                with open(os.path.join(feats, name)) as f:
                    b = json.load(f)
            except (OSError, ValueError):
                continue
            if b.get("branch") == branch and (b.get("status") == "agreed" or
                                              (b.get("status") == "scoping" and b.get("preview"))):
                return None
    return "deny", (f"No agreed scope for branch {branch}, so code under app/ or etl/ can't be edited yet. Scope it "
                    "with the user first (/scope), then build on the brief's branch (/build).")


def decide(event):
    tool = event.get("tool_name", "")
    inp = event.get("tool_input", {}) or {}
    if tool in ("Write", "Edit", "NotebookEdit"):
        return brief_edit(tool, inp) or scope_gate(tool, inp)
    if tool == "Bash":
        cmd = inp.get("command", "")
        for rule in BASH_RULES:
            r = rule(cmd)
            if r:
                return r
        cwd = event.get("cwd") or os.getcwd()
        return app_db(cmd, cwd) or commit_checks(cmd, cwd) or release_gate(cmd, cwd)
    if tool == "Agent":
        return agent_model(tool, inp)
    return neon_branch_ops(tool, inp) or neon_sql(tool, inp)


def main():
    event = json.load(sys.stdin)
    r = decide(event)
    if r:
        decision, reason = r
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision,
                                                 "permissionDecisionReason": reason}}))


if __name__ == "__main__":
    main()
