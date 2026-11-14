import { Eyebrow } from "@/components/public/site";

export const metadata = { title: "Terms" };

// Placeholder text, plainly marked: the legal wording is the owner's to write (out of scope, neethi-redesign).
export default function Terms() {
  return (
    <main className="mx-auto max-w-[760px] px-4 py-16 sm:px-6 sm:py-24">
      <Eyebrow>Terms</Eyebrow>
      <h1 className="mt-3 text-4xl font-semibold tracking-[-0.035em]">Terms of use</h1>
      <div
        role="note"
        className="mt-8 rounded-xl border border-dashed border-unverified-border bg-unverified p-5 text-[15px] text-unverified-ink"
      >
        <strong>Placeholder.</strong> This page is a draft to be replaced with the final legal text before launch.
      </div>
      <div className="mt-8 space-y-4 text-[15px] leading-relaxed text-muted-foreground">
        <p>[Who may use Neethi: practising lawyers and those working under them.]</p>
        <p>[Neethi is a research aid, not legal advice: you read the cited text and make the call.]</p>
        <p>[Plans, prices and limits, once announced.]</p>
        <p>[Acceptable use, liability, and how these terms change.]</p>
      </div>
    </main>
  );
}
