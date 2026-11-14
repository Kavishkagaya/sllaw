import { Eyebrow } from "@/components/public/site";

export const metadata = { title: "Privacy" };

// Placeholder text, plainly marked: the legal wording is the owner's to write (out of scope, neethi-redesign).
export default function Privacy() {
  return (
    <main className="mx-auto max-w-[760px] px-4 py-16 sm:px-6 sm:py-24">
      <Eyebrow>Privacy</Eyebrow>
      <h1 className="mt-3 text-4xl font-semibold tracking-[-0.035em]">Privacy policy</h1>
      <div
        role="note"
        className="mt-8 rounded-xl border border-dashed border-unverified-border bg-unverified p-5 text-[15px] text-unverified-ink"
      >
        <strong>Placeholder.</strong> This page is a draft to be replaced with the final legal text before launch.
      </div>
      <div className="mt-8 space-y-4 text-[15px] leading-relaxed text-muted-foreground">
        <p>[Who we are and how to contact us.]</p>
        <p>
          [What we collect: your account, the cases, files and chats you create, and usage needed to run and bill the
          service.]
        </p>
        <p>[Who can see it: you alone; the processors we use to host, store and answer (named here).]</p>
        <p>[How long we keep it, and how to delete your account and data.]</p>
      </div>
    </main>
  );
}
