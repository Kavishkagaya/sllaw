"use client";

import { useEffect, useState } from "react";
import { BrandMark } from "@/components/brand";

// The landing hero's chat (landing-motion): three lawyers' questions, played in turn. All three are rendered, layered
// in one grid cell, so the card keeps the size of the longest and the server HTML carries every word; only the active
// one is visible, and its steps play (globals.css, .hero-play). Without motion (reduced, or no JS) the first stays
// still. Every quoted law is verbatim from the corpus (the Constitution, Articles 12(2), 13(1), 13(2)).
type Exchange = {
  q: string;
  title: string;
  answer: [string, string, string, string]; // text, chip, text, chip
  next: string;
  article: string;
  law: string;
};

const EXCHANGES: Exchange[] = [
  {
    q: "My client was arrested at home and nobody told him why. Do we have a fundamental rights case?",
    title: "Very likely, under Article 13(1).",
    answer: [
      "A person arrested must be informed of the reason for the arrest",
      "Art. 13(1)",
      "An arrest without a reason given is open to challenge before the Supreme Court",
      "Art. 126",
    ],
    next: "Open a case and add the arrest note and his affidavit: I will check what the record says and what is missing.",
    article: "Article 13 · Freedom from arbitrary arrest",
    law: "(1) No person shall be arrested except according to procedure established by law. Any person arrested shall be informed of the reason for his arrest.",
  },
  {
    q: "He has been held for three days and never taken before a Magistrate. What can we do?",
    title: "He must be brought before a judge.",
    answer: [
      "Anyone held in custody must be brought before a judge, and held further only on that judge's order",
      "Art. 13(2)",
      "Petition the Supreme Court within one month",
      "Art. 126(2)",
    ],
    next: "Note the time of arrest and every day since: the one month runs from the infringement.",
    article: "Article 13 · Freedom from arbitrary detention",
    law: "(2) Every person held in custody, detained or otherwise deprived of personal liberty shall be brought before the judge of the nearest competent court according to procedure established by law…",
  },
  {
    q: "The ministry refused my client's transfer, and she says it was because of her caste. Is that a fundamental rights matter?",
    title: "Yes, under Article 12(2).",
    answer: [
      "No citizen may be discriminated against on the ground of caste",
      "Art. 12(2)",
      "The ministry's refusal is executive action, open to the Supreme Court",
      "Art. 126(1)",
    ],
    next: "Add the refusal letter and anything that shows the reason: the case turns on what the record proves.",
    article: "Article 12 · Right to equality",
    law: "(2) No citizen shall be discriminated against on the grounds of race, religion, language, caste, sex, political opinion, place of birth or any one of such grounds…",
  },
];

const PLAY_MS = 11000; // one exchange: ~4.6 s of play, then held (globals.css hero-fill runs as long)
const LEAVE_MS = 500;

const lawChip = "rounded-[5px] bg-law px-[7px] py-px text-[12.5px] font-medium whitespace-nowrap text-law-ink";
const d = (s: string) => ({ "--d": s }) as React.CSSProperties;

export function HeroChat() {
  const [active, setActive] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!matchMedia("(prefers-reduced-motion: no-preference)").matches) return;
    let leave: ReturnType<typeof setTimeout>;
    const tick = setInterval(() => {
      setLeaving(true);
      leave = setTimeout(() => {
        setActive((i) => (i + 1) % EXCHANGES.length);
        setLeaving(false);
      }, LEAVE_MS);
    }, PLAY_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(leave);
    };
  }, []);

  const layer = (i: number) =>
    `[grid-area:1/1] transition-opacity duration-500 ${i === active ? (leaving ? "opacity-0" : "hero-play") : "invisible"}`;

  return (
    <div className="relative pb-10 text-left lg:pb-0">
      {/* a warm glow behind the card */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-10 -inset-y-6 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--primary)_22%,transparent),transparent)] blur-2xl"
      />
      <div className="relative overflow-hidden rounded-2xl border border-input bg-card shadow-[0_40px_90px_-45px_rgb(22_20_15/0.6)]">
        {/* the app's chat header, with which of the three questions is playing */}
        <div className="flex items-center gap-2.5 border-b bg-background/60 px-4 py-2.5 sm:px-8 sm:py-3">
          <BrandMark className="size-[18px]" />
          <span className="text-[13px] font-medium">New chat</span>
          <span className="label-mono text-[9.5px] text-muted-foreground">· the law</span>
          <span aria-hidden className="ml-auto flex gap-1.5">
            {EXCHANGES.map((x, i) => (
              <span key={x.q} className="h-1 w-6 overflow-hidden rounded-full bg-border">
                {i <= active && (
                  <span
                    key={i === active ? `on-${active}` : "done"}
                    className={`block h-full origin-left rounded-full bg-primary ${i === active ? "hero-fill" : ""}`}
                  />
                )}
              </span>
            ))}
          </span>
        </div>
        <div className="grid p-4 pb-14 sm:p-5 sm:px-8 sm:pt-6 sm:pb-16">
          {EXCHANGES.map((x, i) => (
            <div key={x.q} aria-hidden={i !== active} className={`flex flex-col gap-4.5 ${layer(i)}`}>
              <div
                style={d("0.4s")}
                className="hero-step max-w-[88%] self-end rounded-[12px_12px_4px_12px] bg-[#16140f] px-3.5 py-2.5 text-[13.5px] leading-normal sm:max-w-[85%] sm:px-4 sm:py-3 sm:text-[15px] text-[#f3f1ec] dark:bg-[#2a2620]"
              >
                {x.q}
              </div>
              <div className="flex gap-3">
                <BrandMark />
                <div className="min-w-0 flex-1">
                  <div className="label-mono grid text-[10px] text-muted-foreground">
                    <span aria-hidden className="hero-trail opacity-0 [grid-area:1/1]">
                      Reading the Constitution…
                    </span>
                    <span style={d("2.2s")} className="hero-step [grid-area:1/1]">
                      Read 2 Articles · checked 2 citations
                    </span>
                  </div>
                  <div
                    style={d("2.4s")}
                    className="hero-step my-1.5 text-[17px] font-semibold tracking-[-0.02em] sm:my-2 sm:text-[21px]"
                  >
                    {x.title}
                  </div>
                  <p className="mb-2.5 text-[13.5px] leading-[1.6] sm:text-[15px] sm:leading-[1.65]">
                    <span style={d("2.7s")} className="hero-step">
                      {x.answer[0]} <span className={`hero-cite ${lawChip}`}>{x.answer[1]}</span>.
                    </span>{" "}
                    <span style={d("3s")} className="hero-step">
                      {x.answer[2]} <span className={lawChip}>{x.answer[3]}</span>.
                    </span>
                  </p>
                  <p
                    style={d("3.3s")}
                    className="hero-step text-[15px] leading-[1.65] text-muted-foreground max-sm:hidden"
                  >
                    {x.next}
                  </p>
                </div>
              </div>
            </div>
          ))}
          <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-input py-2 pr-2 pl-3.5 text-[13.5px] text-muted-foreground sm:mt-5 sm:py-2.5 sm:pr-2.5 sm:pl-4 sm:text-[15px]">
            <span aria-hidden className="hero-caret h-4.5 w-px bg-foreground" />
            <span className="flex-1">Ask a follow-up…</span>
            <span
              aria-hidden
              className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground sm:size-9"
            >
              ↑
            </span>
          </div>
        </div>
      </div>
      {/* the cited Article, opening once the answer is done */}
      <div className="relative -mt-10 ml-auto grid w-[92%] sm:-mt-12 sm:w-[78%]">
        {EXCHANGES.map((x, i) => (
          <div
            key={x.q}
            aria-hidden={i !== active}
            className={`hero-rise flex flex-col gap-2 rounded-xl border border-input bg-background p-4 shadow-[0_24px_50px_-28px_rgb(22_20_15/0.55)] ${layer(i)}`}
          >
            <div className="label-mono text-[10px] text-primary">The Constitution · in force today</div>
            <div className="font-law text-[16px] sm:text-[18px]">{x.article}</div>
            <p className="hero-mark mt-1 rounded bg-law-mark px-2.5 py-2 font-law text-[13.5px] leading-[1.6] sm:text-[14.5px] sm:leading-[1.65]">
              <b>{x.article.match(/\d+/)?.[0]}.</b> {x.law}
            </p>
            <div className="pt-1 text-[12.5px] text-muted-foreground">Open in full · Amended by · Cited by</div>
          </div>
        ))}
      </div>
    </div>
  );
}
