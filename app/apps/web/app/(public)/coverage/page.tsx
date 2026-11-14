import { CoverageStats, fmtUpdated } from "@/components/public/coverage-stats";
import { Eyebrow } from "@/components/public/site";
import { serverApi } from "@/trpc/server";

export const metadata = { title: "Coverage" };

const WHAT = [
  ["The Constitution", "The Constitution of 1978 with its amendments, each Article followed to the text in force."],
  ["Acts and Laws", "Acts of Parliament and Laws of the National State Assembly, as enacted and as amended."],
  ["Revised Editions", "The Legislative Enactments of 1956 and 1980, chapter by chapter."],
  ["Gazettes", "Regulations and orders published in the Gazette, linked to the Acts they are made under."],
] as const;

// What Neethi answers from (d4): live counts from the corpus (one cached query of a few rows) and what each kind is.
export default async function Coverage() {
  const counts = await (await serverApi()).corpus.coverage().catch(() => null);
  return (
    <main>
      <section className="relative overflow-hidden bg-[#16140f] text-[#f3f1ec] dark:border-b dark:border-white/10">
        <div
          aria-hidden
          className="absolute -top-16 -right-16 size-[460px] rounded-full opacity-50 [background-image:radial-gradient(circle,rgb(230_169_179/0.35)_1.2px,transparent_1.5px)] [background-size:11px_11px]"
        />
        <div className="relative mx-auto max-w-[1200px] px-4 py-16 sm:px-6 sm:py-24">
          <Eyebrow className="text-[#e6a9b3]!">Coverage</Eyebrow>
          <h1 className="mt-3 max-w-[640px] text-4xl leading-[1.04] font-semibold tracking-[-0.035em] sm:text-5xl">
            The law of Sri Lanka, as it stands today.
          </h1>
          <p className="mt-5 max-w-[560px] text-[17px] leading-relaxed text-[#b8b1a4]">
            Neethi answers from these, and only these. The corpus is rebuilt every night from the official sources; the
            counts below are live.
          </p>
          <CoverageStats counts={counts} className="mt-10 max-w-[640px]" />
        </div>
      </section>
      <section className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6 sm:py-20">
        <div className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2">
          {WHAT.map(([t, p]) => (
            <div key={t} className="bg-card p-7">
              <h2 className="text-lg font-semibold tracking-[-0.02em]">{t}</h2>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">{p}</p>
            </div>
          ))}
        </div>
        <p className="mt-8 text-sm text-muted-foreground">
          Not yet covered: judgments of the Supreme Court and the Court of Appeal (next). Last updated{" "}
          {fmtUpdated(counts?.updated)}.
        </p>
      </section>
    </main>
  );
}
