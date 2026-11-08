"""python3 -m etl.v2.golddump [--n 50] [--seed 7] [--keys ...] -- material for hand-labelling the structure gold set.

Picks amending laws at random (seeded; the laws the quote rules were tuned on are left out, so the set measures
them fairly) and prints, per law, the paragraphs a reader needs to tell the law's own sections from quoted text:
every paragraph opening with a number, every amending formula, headings, and paragraphs with a quote mark at
either end; each with its index, page and note. v2's own reading is not shown. Read-only.
"""
import argparse, random, re

from etl.v2 import blocks as b3, gate
from etl.v2.profiles import profile

TUNED = {"act:29/1981", "act:3/1994", "act:36/1982", "act:35/1998", "law:37/1974", "act:24/2018", "act:27/1981",
         "act:31/1995", "act:1/2018", "act:16/1981", "act:13/1965", "act:12/1999", "act:10/2011", "act:23/1980",
         "law:24/1974", "law:40/1973", "act:10/2024", "act:13/1992", "act:14/1996", "act:16/2003", "act:2/2005",
         "act:9/1994", "act:11/1964", "act:56/1979", "act:16/1989", "act:10/1968", "law:20/1977", "law:41/1975"}
SHOW = re.compile(r"^\s*(?:[\"'“‘]\s*)?\d{1,3}[A-Z]{0,4}\s*\.\s|hereby|principal enactment|\bPART\b|SCHEDULE|^\s*[\"'“‘]|[\"'”’]\s*[.;]?\s*$")


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--n", type=int, default=50)
    a.add_argument("--seed", type=int, default=7)
    a.add_argument("--keys")
    args = a.parse_args()
    gate._init()
    rows = [r for r in gate.rows(None, None) if not r[0].startswith("gazette") and "AMENDMENT" in (r[1] or "").upper()
            and not r[0].startswith("constitution")]
    if args.keys:
        pick = [r for r in rows if r[0] in set(args.keys.split(","))]
    else:
        pick = random.Random(args.seed).sample([r for r in rows if r[0] not in TUNED], args.n)
    for key, title, sha, raw_key, meta in sorted(pick):
        raw = gate._get(raw_key)
        try:
            lo = gate._get(f"raw/lighton/{sha}.json.gz")
        except Exception:
            lo = None
        bs, engine = b3.read(raw, lo, le1980=bool(meta.get("cap")), spread=bool(meta.get("spread")))
        paras, _ = b3.paragraphs(bs, engine, gazette=False)
        print(f"\n### {key} ({engine}) {title.strip()[:80]}")
        for i, p in enumerate(paras):
            t = re.sub(r"\s+", " ", p["text"]).strip()
            if SHOW.search(t):
                note = f"  [{p['note'][:60]}]" if p.get("note") else ""
                print(f"{i:4} {t[:150]}{note}")


if __name__ == "__main__":
    main()
