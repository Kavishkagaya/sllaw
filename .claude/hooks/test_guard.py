#!/usr/bin/env python3
"""Checks for guard.py: python3 .claude/hooks/test_guard.py. A new rule gets a case here."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard import decide  # noqa: E402


def bash(cmd):
    r = decide({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": "/nonexistent"})
    return r[0] if r else None


CASES = [
    ("git worktree add -b app/x ../sllaw-x origin/main", "deny"),
    ("git worktree list", None),
    ("gh pr merge 41", "deny"),
    ("agent-browser open http://localhost:3000", "deny"),
    ("agent-browser --headed open http://localhost:3000", None),
    ("agent-browser snapshot", None),
    ("pip install torch", "ask"),
    ("/var/tmp/e19309/bin/uv pip install vllm", "ask"),
    ("pnpm add zod", "ask"),
    ("pnpm install", None),
    ("pnpm -s typecheck", None),
    ("hf download lightonai/LightOnOCR", "ask"),
    ("curl -s https://example.com | head", None),
    ("curl -o x.pdf https://example.com/x.pdf", "ask"),
    ("wget https://example.com/x.pdf", "ask"),
    ("python -m etl.v2.run embed --apply", "ask"),
    ("python -m etl.v2.run status", None),
    ("python -m etl.publish", "ask"),
    ("git push --force origin main", "ask"),
    ("git push origin feature-x", None),
    ("git status", None),
    ("python3 - <<'EOF'\nb=json.load(open('docs/features/x.json')); json.dump(b,open('docs/features/x.json','w'))\nEOF",
     "deny"),
    ("sed -i 's/scoping/agreed/' docs/features/x.json", "deny"),
    ("echo '{}' > docs/features/x.json", "deny"),
    ("cat docs/features/x.json", None),
    ("grep -n status docs/features/x.json", None),
    ("git add docs/features/x.json", None),
    ("cp docs/features/x.json ../sllaw-x/docs/features/", None),
    ("python3 - <<'EOF'\np='docs/features/x.json'; b=json.load(open(p)); b['status']='agreed'\njson.dump(b,open(p,'w'))\nEOF",
     "deny"),
    ("python3 -c \"open('docs/features/x.json','w').write('{}')\"", "deny"),
    ("rm docs/features/x.json", "deny"),
    # a doc that quotes a brief's path is not a write to the brief
    ("python3 - <<'EOF'\np='docs/APP.md'; s=open(p).read(); s+='brief docs/features/x.json'; open(p,'w').write(s)\nEOF",
     None),
]

bad = 0
for cmd, want in CASES:
    got = bash(cmd)
    if got != want:
        bad += 1
        print(f"FAIL {cmd!r}: got {got}, want {want}")
r = decide({"tool_name": "mcp__claude_ai_Neon__run_sql", "tool_input": {}})
if not r or r[0] != "ask":
    bad += 1
    print("FAIL neon run_sql should ask")

# release gate, in a throwaway repo: origin/main, then a code commit on a branch
import subprocess  # noqa: E402
import tempfile  # noqa: E402

n = len(CASES) + 1
with tempfile.TemporaryDirectory() as d:
    def g(*a):
        return subprocess.run(["git", "-C", d, *a], capture_output=True, text=True, check=True).stdout.strip()

    def gate(cmd):
        r = decide({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": d})
        return r[0] if r else None

    def report(sha, v, verdict):
        os.makedirs(os.path.join(d, ".git", "validation", sha), exist_ok=True)
        with open(os.path.join(d, ".git", "validation", sha, v + ".md"), "w") as f:
            f.write(f"VERDICT: {verdict}\n")

    g("init", "-q", "-b", "main")
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base")
    g("update-ref", "refs/remotes/origin/main", "HEAD")
    g("checkout", "-q", "-b", "feat")
    open(os.path.join(d, "a.ts"), "w").write("x\n")
    g("add", "a.ts")
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "code")
    sha = g("rev-parse", "HEAD")
    steps = [
        ("gh pr create --fill", "deny", None),                       # no reports
        ("gh pr merge 7 --rebase", "deny", None),                    # no --match-head-commit
        ("git push origin HEAD:main", "deny", None),
        ("vercel deploy --prod", "deny", None),
        ("git push origin feat", None, None),                        # a branch push is not going out
        ("gh pr create --fill", "deny", ("semantic", "PASS")),       # one of two
        ("gh pr create --fill", "deny", ("security", "FAIL")),       # one failed
        ("gh pr create --fill", None, ("security", "PASS")),         # both pass
        (f"gh pr merge 7 --rebase --match-head-commit {sha}", None, None),
        ("git push origin HEAD:main", None, None),
    ]
    for cmd, want, rep in steps:
        if rep:
            report(sha, *rep)
        n += 1
        got = gate(cmd)
        if got != want:
            bad += 1
            print(f"FAIL gate {cmd!r} after {rep}: got {got}, want {want}")
    open(os.path.join(d, "NOTES.md"), "w").write("x\n")             # a new docs-only commit needs no validation
    g("add", "NOTES.md")
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "docs")
    g("update-ref", "refs/remotes/origin/main", sha)
    n += 1
    if gate("git push origin HEAD:main") is not None:
        bad += 1
        print("FAIL gate: docs-only commit should pass")

# scope rules: brief lifecycle and the code-edit gate
import json  # noqa: E402

with tempfile.TemporaryDirectory() as d:
    subprocess.run(["git", "-C", d, "init", "-q", "-b", "app/x"], check=True)
    os.makedirs(os.path.join(d, "docs", "features"))
    os.makedirs(os.path.join(d, "app"))
    bp = os.path.join(d, "docs", "features", "x.json")
    code = os.path.join(d, "app", "a.ts")
    brief = {"title": "X", "status": "scoping", "branch": "app/x", "goal": "g", "done_check": [{"id": "d1", "check": "c"}],
             "scenarios": [], "out_of_scope": [], "progress": []}

    def edit(tool, path, **kw):
        r = decide({"tool_name": tool, "tool_input": {"file_path": path, **kw}, "cwd": d})
        return r[0] if r else None

    def put(b):
        with open(bp, "w") as f:
            json.dump(b, f)

    checks = [
        ("code edit, no brief", edit("Write", code, content="x"), "deny"),
        ("doc edit, no brief", edit("Write", os.path.join(d, "app", "README.md"), content="x"), None),
        ("new brief agreed at once", edit("Write", bp, content=json.dumps({**brief, "status": "agreed"})), "deny"),
        ("new brief in scoping", edit("Write", bp, content=json.dumps(brief)), None),
        ("brief not JSON", edit("Write", bp, content="{"), "deny"),
    ]
    put(brief)
    checks += [
        ("scoping edits goal freely", edit("Write", bp, content=json.dumps({**brief, "goal": "g2"})), None),
        ("code edit while scoping", edit("Write", code, content="x"), "deny"),
        ("sign-off asks the user", edit("Write", bp, content=json.dumps({**brief, "status": "agreed"})), "ask"),
        ("preview asks the user", edit("Write", bp, content=json.dumps({**brief, "preview": True})), "ask"),
    ]
    put({**brief, "preview": True})
    checks.append(("code edit in a preview", edit("Write", code, content="x"), None))
    put(brief)
    put({**brief, "status": "agreed"})
    agreed = {**brief, "status": "agreed"}
    checks += [
        ("code edit when agreed", edit("Write", code, content="x"), None),
        ("frozen goal", edit("Write", bp, content=json.dumps({**agreed, "goal": "other"})), "deny"),
        ("frozen via Edit", edit("Edit", bp, old_string='"c"', new_string='"easier"'), "deny"),
        ("progress may grow", edit("Write", bp, content=json.dumps({**agreed, "progress": [{"note": "n"}]})), None),
        ("reopen asks", edit("Write", bp, content=json.dumps({**agreed, "status": "scoping"})), "ask"),
        ("merged ok", edit("Write", bp, content=json.dumps({**agreed, "status": "merged"})), None),
    ]
    put({**brief, "status": "merged"})
    checks.append(("code edit after merge", edit("Write", code, content="x"), "deny"))
    for name, got, want in checks:
        n += 1
        if got != want:
            bad += 1
            print(f"FAIL scope {name}: got {got}, want {want}")

import guard  # noqa: E402

cfg = guard.agent_db()
with tempfile.TemporaryDirectory() as d:
    subprocess.run(["git", "-C", d, "init", "-q", "-b", "main"], check=True)
    env = os.path.join(d, "app", "apps", "web")
    os.makedirs(env)
    prod = f"postgresql://u:p@{cfg['main_endpoint']}-pooler.x.neon.tech/app"
    other = "postgresql://u:p@ep-agent-branch-123.x.neon.tech/app"

    def setenv(url):
        with open(os.path.join(env, ".env.local"), "w") as f:
            f.write(f"DATABASE_URL={url}\n")

    def run(cmd):
        r = decide({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": d})
        return r[0] if r else None

    setenv(prod)
    cases = [("main: dev on prod", run("pnpm dev"), None),
             ("main: migrate on prod", run("pnpm --filter @sllaw/db migrate"), "ask")]
    subprocess.run(["git", "-C", d, "checkout", "-q", "-b", "app/x"], check=True)
    cases += [("brief: dev on prod", run("pnpm dev"), "deny"),
              ("brief: eval on prod", run("cd app && pnpm --filter @sllaw/services eval-agent"), "deny")]
    setenv(other)
    cases += [("brief: dev on branch", run("pnpm dev"), None),
              ("brief: migrate on branch", run("pnpm --filter @sllaw/db migrate"), None),
              ("brief: inline prod url", run(f"DATABASE_URL={prod} pnpm --filter @sllaw/db migrate"), "deny")]
    nb = lambda tool, **kw: (lambda r: r[0] if r else None)(decide({"tool_name": tool, "tool_input": kw}))  # noqa: E731
    cases += [("delete main branch", nb("mcp__claude_ai_Neon__delete_branch", branch_id=cfg["main_branch_id"]), "deny"),
              ("delete agent branch", nb("mcp__claude_ai_Neon__delete_branch", branch_id="br-agent-1"), None),
              ("delete project", nb("mcp__claude_ai_Neon__delete_project", project_id="x"), "deny"),
              ("sql on agent branch", nb("mcp__claude_ai_Neon__run_sql", project_id=cfg["project_id"],
                                         branch_id="br-agent-1"), None),
              ("sql on main", nb("mcp__claude_ai_Neon__run_sql", project_id=cfg["project_id"]), "ask")]
    ag = lambda **kw: (lambda r: r[0] if r else None)(decide({"tool_name": "Agent", "tool_input": kw}))  # noqa: E731
    cases += [("agent without model", ag(subagent_type="Explore", prompt="x"), "deny"),
              ("agent default type without model", ag(prompt="x"), "deny"),
              ("agent with model", ag(subagent_type="Explore", prompt="x", model="haiku"), None),
              ("validator without model", ag(subagent_type="semantic-validator", prompt="x"), "deny"),
              ("fork", ag(subagent_type="fork", prompt="x"), None)]
    for name, got, want in cases:
        n += 1
        if got != want:
            bad += 1
            print(f"FAIL db {name}: got {got}, want {want}")

print(f"{n - bad}/{n} ok")
sys.exit(1 if bad else 0)
