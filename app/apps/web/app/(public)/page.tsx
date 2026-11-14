import Link from "next/link";
import { CoverageStats } from "@/components/public/coverage-stats";
import { HeroChat } from "@/components/public/hero-chat";
import { LandingMotion, MOTION_FLAG } from "@/components/public/landing-motion";
import { btn, cta, ctaQuiet, Eyebrow, Plans } from "@/components/public/site";
import { serverApi } from "@/trpc/server";

// The public landing (neethi-redesign d3), in the agreed order: hero (the colleague), Introducing Case, the colleague at
// work, the law as it stands, trust, pricing, FAQ, the closing banner. Every quoted law is verbatim from the corpus
// (the Constitution, Article 12(1) here; the hero's in hero-chat.tsx).
export const metadata = { title: { absolute: "Neethi · Your AI colleague for Sri Lankan law" } };

const ART_12_1 = "All persons are equal before the law and are entitled to the equal protection of the law.";

const h2 = "mt-3 text-4xl leading-[1.04] font-semibold tracking-[-0.035em] sm:text-5xl";
/** CSS custom properties for the landing motion (--i stagger, --d hero delay, --fx/--fy a paper's start). */
const v = (o: Record<string, string | number>) => o as React.CSSProperties;

export default async function Landing() {
  const counts = await (await serverApi()).corpus.coverage().catch(() => null);
  return (
    <main>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string of ours, set before first paint */}
      <script dangerouslySetInnerHTML={{ __html: MOTION_FLAG }} />
      <LandingMotion />
      <Hero />
      <CaseSection />
      <AtWork />
      <section
        id="law"
        className="relative overflow-hidden bg-[#16140f] text-[#f3f1ec] dark:border-y dark:border-white/10"
      >
        <div
          aria-hidden
          className="absolute -top-16 -right-16 size-[460px] rounded-full opacity-50 [background-image:radial-gradient(circle,rgb(230_169_179/0.35)_1.2px,transparent_1.5px)] [background-size:11px_11px]"
        />
        <div className="relative mx-auto flex max-w-[1200px] flex-wrap gap-14 px-4 py-20 sm:px-6 sm:py-26">
          <div data-reveal className="min-w-0 flex-[1_1_440px]">
            <Eyebrow className="text-[#e6a9b3]!">The law as it stands</Eyebrow>
            <h2 className={`${h2} max-w-[560px]`}>The version in force. Not the one in your old copy.</h2>
            <p className="mt-5 max-w-[500px] text-[17px] leading-relaxed text-[#b8b1a4]">
              Sri Lankan Acts are amended section by section, over decades. Neethi follows every section of the
              Constitution, the Acts and the Revised Editions through each amendment, so the text you cite is the text
              in force, and you can see what changed and when.
            </p>
            <CoverageStats counts={counts} className="mt-9 max-w-[500px]" />
          </div>
          <div
            data-reveal
            data-draw
            style={v({ "--i": 1 })}
            className="min-w-0 flex-[1_1_440px] rounded-2xl border border-[#3a362e] bg-[#1f1c16] p-6 sm:p-7"
          >
            <div className="label-mono text-[10.5px] text-[#a59e90]">The Constitution · Article 12</div>
            <div className="mt-2 font-law text-[22px]">Right to equality</div>
            <Timeline />
            <p className="mt-3.5 font-law text-[17px] leading-[1.7]">
              <b>12.</b> (1) {ART_12_1}
            </p>
            <div className="mt-5 flex items-center gap-4 border-t border-[#3a362e] pt-2 text-[13.5px] text-[#b8b1a4]">
              <span>Amended by</span>
              <span>Cited by</span>
              <Link
                href="/coverage"
                className="ml-auto inline-flex min-h-11 items-center text-[#e6a9b3] hover:text-white"
              >
                What we cover →
              </Link>
            </div>
          </div>
        </div>
      </section>
      <Trust />
      <section id="pricing" className="dots border-y">
        <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6 sm:py-26">
          <div data-reveal>
            <Eyebrow>Pricing</Eyebrow>
            <h2 className={h2}>Start free. Grow into it.</h2>
            <p className="mt-3.5 mb-11 text-muted-foreground">Prices in LKR to be announced.</p>
          </div>
          <div data-reveal style={v({ "--i": 1 })}>
            <Plans />
          </div>
        </div>
      </section>
      <Faq />
      <section className="relative overflow-hidden bg-[#7d1d2c] text-white">
        <div
          aria-hidden
          className="absolute inset-0 [background-image:radial-gradient(circle,rgb(255_255_255/0.14)_1px,transparent_1.3px)] [background-size:14px_14px]"
        />
        <div className="relative mx-auto flex max-w-[1200px] flex-wrap items-center gap-7 px-4 py-20 sm:px-6">
          <h2
            data-reveal
            className="flex-[1_1_480px] text-4xl leading-none font-semibold tracking-[-0.04em] sm:text-[52px]"
          >
            Your next date is coming.
            <br />
            Be ready for it.
          </h2>
          <Link
            href="/sign-up"
            data-reveal
            style={v({ "--i": 2 })}
            className={`${btn} bg-white text-[#7d1d2c] hover:bg-[#f5e9ea]`}
          >
            Open your first case, free
          </Link>
        </div>
      </section>
    </main>
  );
}

function Hero() {
  return (
    <section className="dots relative overflow-hidden border-b">
      <div className="relative mx-auto flex max-w-[1200px] flex-col items-center px-4 pt-8 text-center sm:px-6 sm:pt-20 lg:flex-row lg:gap-12 lg:py-20 lg:text-left">
        <div className="flex flex-col items-center lg:min-w-0 lg:flex-[1_1_0] lg:items-start">
          <Link
            href="#product"
            className="inline-flex items-center gap-2 rounded-full border bg-card py-1 pr-3 pl-1 text-[13px] sm:gap-2.5 sm:py-1.5 sm:pr-3.5 sm:pl-1.5 sm:text-sm shadow-[0_6px_18px_-12px_rgb(22_20_15/0.4)]"
          >
            <span className="label-mono rounded-full bg-primary px-2.5 py-1 text-[10px] text-primary-foreground">
              New
            </span>
            Introducing Neethi<span className="text-primary">→</span>
          </Link>
          <h1 className="mt-5 max-w-[960px] text-[38px] leading-[1.02] font-semibold tracking-[-0.045em] text-balance sm:mt-7 sm:text-7xl sm:leading-[0.95] sm:tracking-[-0.055em] lg:text-[64px] xl:text-[76px]">
            Your AI colleague
            <br />
            <span className="text-primary">for Sri Lankan law.</span>
          </h1>
          <p className="mt-6 hidden max-w-[660px] text-lg leading-normal text-muted-foreground sm:block sm:text-xl">
            Ask it what you would ask a sharp senior. It knows the law as it stands today, reads your case papers, and
            answers with citations you can check before you stand up in court.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3 sm:mt-8 lg:justify-start">
            <Link href="/sign-up" className={cta}>
              Ask your first question, free
            </Link>
            <Link href="#case" className={`${ctaQuiet} max-sm:hidden`}>
              See it work on a case
            </Link>
          </div>
          <p className="mt-5 hidden text-sm text-muted-foreground sm:block">
            Ask in English, <span lang="si">සිංහල</span> or <span lang="ta">தமிழ்</span>.
          </p>
        </div>

        <div className="relative mt-10 w-full max-w-[1040px] sm:mt-28 lg:mt-0 lg:min-w-0 lg:flex-[1.2_1_0]">
          <svg
            viewBox="0 0 1040 360"
            aria-hidden
            className="absolute inset-x-0 -top-24 hidden h-[360px] w-full sm:block lg:hidden"
          >
            <defs>
              <pattern id="hero-dots" width="11" height="11" patternUnits="userSpaceOnUse">
                <circle cx="5.5" cy="5.5" r="2.4" className="fill-primary" />
              </pattern>
              <mask id="hero-arch">
                <rect width="1040" height="360" fill="black" />
                <path
                  d="M290 400V300a230 230 0 0 1 460 0v100"
                  fill="none"
                  stroke="white"
                  strokeWidth="90"
                  strokeLinecap="round"
                />
              </mask>
            </defs>
            <rect width="1040" height="360" fill="url(#hero-dots)" mask="url(#hero-arch)" opacity=".5" />
          </svg>
          <HeroChat />
        </div>
      </div>
    </section>
  );
}

const CASE_POINTS = [
  ["The papers", "Plaint, affidavits, letters: read on upload, grouped by kind, searchable by page."],
  ["The diary", "Every date and what happened on it, the next step, the tasks before it."],
  ["The conversations", "Every chat about the matter stays with it, so nothing is asked twice."],
  ["Shared with your juniors", "Give a junior the case to read or to work on. Their chats stay their own."],
] as const;

function CaseSection() {
  const doc = (fill: string, stroke: string) => (
    <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden>
      <path d="M1 1h8l4 4v10H1z" fill={fill} stroke={stroke} />
    </svg>
  );
  return (
    <section id="case" className="overflow-hidden border-b bg-muted">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-16 px-4 py-20 sm:px-6 sm:py-26">
        <div data-reveal className="min-w-0 flex-[1_1_420px]">
          <Eyebrow>Introducing Case</Eyebrow>
          <h2 className={h2}>A workspace for every matter.</h2>
          <p className="mt-4.5 max-w-[480px] text-[17px] leading-relaxed text-muted-foreground">
            Open a case once. From then on your colleague answers from your papers and your dates, not just the statute
            book.
          </p>
          <ol className="mt-9 border-t border-input">
            {CASE_POINTS.map(([title, text], i) => (
              <li
                key={title}
                data-reveal
                style={v({ "--i": i + 1 })}
                className="flex gap-4.5 border-b border-input py-4.5"
              >
                <span className="pt-0.5 font-mono text-xs text-primary">0{i + 1}</span>
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-[17px] font-semibold">
                    {title}
                    {i === 3 && (
                      <span className="label-mono rounded-full border border-law-border bg-law px-2 py-0.5 text-[9.5px] text-law-ink">
                        Coming soon
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[14.5px] leading-normal text-muted-foreground">{text}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
        {/* the case's papers, fanned */}
        <div aria-hidden data-reveal data-fan className="relative h-[560px] min-w-0 flex-[1_1_480px] max-sm:h-[620px]">
          <div className="absolute inset-[20px_0_0_40px] rounded-3xl [background-image:radial-gradient(circle,var(--dot)_1.2px,transparent_1.5px)] [background-size:12px_12px] max-sm:left-0" />
          <div
            data-paper
            style={v({ "--i": 0, "--fx": "70px", "--fy": "120px" })}
            className="absolute top-15 left-0 w-[330px] max-w-[88%] -rotate-4 rounded-xl border border-input bg-card px-4.5 py-4 shadow-[0_20px_40px_-24px_rgb(22_20_15/0.45)]"
          >
            <div className="label-mono text-[9.5px] text-muted-foreground">Files · 7</div>
            <div className="mt-3 flex flex-col gap-2.5 text-[13.5px]">
              {[
                ["Petition", "12 pp", true],
                ["Affidavit of the petitioner", "6 pp", true],
                ["Arrest note", "2 pp", false],
              ].map(([t, pp, law]) => (
                <span key={t as string} className="flex items-center gap-2.5">
                  {law ? doc("var(--law)", "var(--primary)") : doc("var(--file)", "var(--muted-foreground)")}
                  {t}
                  <span className="ml-auto text-[11.5px] text-muted-foreground">{pp}</span>
                </span>
              ))}
            </div>
          </div>
          <div
            data-paper
            style={v({ "--i": 1, "--fx": "-90px", "--fy": "60px" })}
            className="absolute top-[150px] right-0 w-[300px] max-w-[80%] rotate-3 rounded-xl bg-[#16140f] px-4.5 py-4 text-[#f3f1ec] shadow-[0_24px_44px_-22px_rgb(22_20_15/0.6)] max-sm:top-[230px]"
          >
            <div className="label-mono text-[9.5px] text-[#e6a9b3]">Diary</div>
            <div className="mt-3 flex flex-col gap-2.5 text-[13.5px]">
              <span className="flex gap-2.5">
                <span className="w-12 font-mono text-[11px] text-[#a59e90]">12 OCT</span>Arrested at home
              </span>
              <span className="flex gap-2.5">
                <span className="w-12 font-mono text-[11px] text-[#a59e90]">20 OCT</span>Petition filed
              </span>
              <span className="flex gap-2.5 font-medium text-[#e6a9b3]">
                <span className="w-12 font-mono text-[11px]">03 DEC</span>Support for leave
              </span>
            </div>
          </div>
          <div
            data-paper
            style={v({ "--i": 2, "--fy": "-40px" })}
            className="absolute bottom-5 left-[70px] w-[380px] max-w-[calc(100%-70px)] rounded-[14px] border border-input bg-card px-5 py-4.5 shadow-[0_30px_60px_-28px_rgb(22_20_15/0.55)] max-sm:left-0 max-sm:max-w-full"
          >
            <div className="flex items-center gap-2.5">
              <span className="w-1.5 self-stretch rounded-sm bg-primary" />
              <div>
                <div className="label-mono text-[9.5px] text-muted-foreground">Supreme Court · FR</div>
                <div className="text-[19px] font-semibold tracking-[-0.02em]">A. v. B. and others</div>
              </div>
              <span className="ml-auto rounded-full bg-law px-2.5 py-1 text-[11.5px] text-law-ink">3 Dec</span>
            </div>
            <div className="mt-3.5 rounded-[10px] border bg-background px-3 py-2.5 text-[13.5px] leading-normal">
              What is still missing before the support date?
            </div>
            <div className="mt-2.5 text-[13.5px] leading-relaxed">
              The extract from the police information book, and the date he was produced before a Magistrate{" "}
              <span className="rounded bg-file px-1.5 text-[11.5px] font-medium text-file-ink">Petition, ¶ 9</span>.
            </div>
          </div>
          <svg
            viewBox="0 0 96 96"
            aria-hidden
            className="absolute right-10 bottom-10 size-[120px] text-primary opacity-90 max-sm:hidden"
          >
            <path
              d="M24 78V46a24 24 0 0 1 48 0v32"
              fill="none"
              stroke="currentColor"
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray="2 7"
            />
          </svg>
        </div>
      </div>
    </section>
  );
}

const TILES = [
  {
    title: "Reads the brief",
    text: "Drop in the plaint, affidavits, letters and notes. Neethi pulls out the parties, the dates and the court, and tells you which facts are still missing.",
    icon: (
      <>
        <rect x="8" y="6" width="22" height="30" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
        <rect x="14" y="10" width="22" height="30" rx="3" className="fill-card" stroke="currentColor" strokeWidth="2" />
        <path d="M19 19h12M19 25h12M19 31h7" className="stroke-primary" strokeWidth="2" />
      </>
    ),
  },
  {
    title: "Keeps the diary",
    text: "Next dates, what happened last time, tasks and people, all on one case page. Your week across every case, on the dashboard.",
    icon: (
      <>
        <rect x="6" y="9" width="32" height="28" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M6 17h32M14 5v8M30 5v8" stroke="currentColor" strokeWidth="2" />
        <circle cx="22" cy="27" r="4" className="fill-primary" />
      </>
    ),
  },
  {
    title: "Gets you ready",
    text: "Before the next date: what the step is, the law on it, what is in your file and what is not. Walk in prepared.",
    icon: (
      <>
        <path d="M10 36V20a12 12 0 0 1 24 0v16" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M6 36h32" stroke="currentColor" strokeWidth="2" />
        <path d="M17 26l4 4 7-8" fill="none" className="stroke-primary" strokeWidth="2.4" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: "Answers you can check",
    text: "Every claim cites the section, or the page of your file, it rests on. One click opens the text. A citation it never read is flagged.",
    icon: (
      <>
        <rect x="5" y="10" width="34" height="24" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
        <rect x="11" y="18" width="12" height="8" rx="2" className="fill-law stroke-primary" strokeWidth="1.6" />
        <path d="M27 22h7" stroke="currentColor" strokeWidth="2" />
      </>
    ),
  },
];

function AtWork() {
  return (
    <section id="product" className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6 sm:py-26">
      <div data-reveal>
        <Eyebrow>Your colleague, at work</Eyebrow>
        <h2 className={`${h2} max-w-[720px]`}>Everything a good junior does. At two in the morning, too.</h2>
      </div>
      <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {TILES.map((t, i) => (
          <div key={t.title} data-reveal style={v({ "--i": i })} className="flex flex-col gap-3 bg-card px-7 py-7.5">
            <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden className="text-foreground">
              {t.icon}
            </svg>
            <h3 className="mt-1.5 text-xl font-semibold tracking-[-0.02em]">{t.title}</h3>
            <p className="text-[15px] leading-relaxed text-muted-foreground">{t.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** A drawn amendment line, enactment to today (decoration: the real timelines are in the sources panel). */
function Timeline() {
  return (
    <svg
      viewBox="0 0 420 64"
      role="img"
      aria-label="Amendment timeline of the Constitution, 1978 to today"
      className="h-16 w-full"
    >
      <path d="M12 24H408" stroke="#4a453b" pathLength={1} />
      <g fill="#e6a9b3" opacity=".3">
        {[40, 60, 80, 120, 140, 160, 200, 220, 260, 280, 320, 340].map((x) => (
          <circle key={x} cx={x} cy="24" r="1.6" data-tick style={v({ "--t": (x - 12) / 396 })} />
        ))}
      </g>
      <circle cx="16" cy="24" r="6" fill="#1f1c16" stroke="#f3f1ec" strokeWidth="1.5" />
      {[100, 180, 240, 300].map((x) => (
        <circle key={x} cx={x} cy="24" r="4" fill="#a59e90" data-tick style={v({ "--t": (x - 12) / 396 })} />
      ))}
      <circle cx="396" cy="24" r="8" fill="#e6a9b3" data-tick style={v({ "--t": 1 })} />
      <text x="16" y="52" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="10" fill="#a59e90">
        1978
      </text>
      <text
        data-tick
        style={v({ "--t": 1 })}
        x="396"
        y="52"
        textAnchor="middle"
        fontFamily="var(--font-mono)"
        fontSize="10"
        fill="#e6a9b3"
      >
        TODAY
      </text>
    </svg>
  );
}

const TRUST = [
  [
    "Every citation is verified",
    "Neethi may only cite text it has read in that chat. Anything else is marked unverified, in plain sight.",
  ],
  ["Your files stay in your case", "Only you can see a case's files and chats."],
  ["Sri Lankan law only", "Answers come from Sri Lankan statutes, not from the internet or another country's law."],
  [
    "Judgments are next",
    "Supreme Court and Court of Appeal decisions join the statutes, linked to the sections they interpret.",
  ],
] as const;

function Trust() {
  return (
    <section className="mx-auto flex max-w-[1200px] flex-wrap gap-10 px-4 py-20 sm:px-6 sm:py-26">
      <div data-reveal className="flex-[1_1_320px]">
        <Eyebrow>Trust</Eyebrow>
        <h2 className="mt-3 text-4xl leading-[1.04] font-semibold tracking-[-0.035em] sm:text-[40px]">
          Built to be checked, not believed.
        </h2>
      </div>
      <div className="grid flex-[2_1_560px] gap-7 sm:grid-cols-2">
        {TRUST.map(([t, p], i) => (
          <div key={t} data-reveal style={v({ "--i": i })}>
            <h3 className="mb-1.5 text-[17px] font-semibold">{t}</h3>
            <p className="text-[15px] leading-relaxed text-muted-foreground">{p}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const FAQ = [
  [
    "Is this legal advice?",
    "No. Neethi is a research and preparation tool for lawyers. You read the cited text and make the call.",
  ],
  [
    "Which laws does it cover?",
    "The Constitution and its amendments, Acts and Laws, the Revised Editions and gazettes, each followed through its amendments. Judgments come next.",
  ],
  ["Can I ask in Sinhala or Tamil?", "Yes. Ask in any of the three languages; the law is quoted as enacted."],
  ["Who sees my case files?", "You. Nobody else."],
] as const;

function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-[860px] px-4 py-20 sm:px-6 sm:py-26">
      <div data-reveal>
        <Eyebrow>Questions</Eyebrow>
        <h2 className="mt-3 mb-8 text-4xl leading-[1.04] font-semibold tracking-[-0.035em] sm:text-[40px]">
          Asked by lawyers.
        </h2>
      </div>
      <div data-reveal style={v({ "--i": 1 })} className="border-b">
        {FAQ.map(([q, a]) => (
          <details key={q} className="group border-t py-5">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 text-[17px] font-medium">
              {q}
              <span aria-hidden className="text-primary transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
