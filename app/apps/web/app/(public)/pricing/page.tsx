import { Eyebrow, Plans } from "@/components/public/site";

export const metadata = { title: "Pricing" };

export default function Pricing() {
  return (
    <main className="dots border-b">
      <div className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6 sm:py-24">
        <Eyebrow>Pricing</Eyebrow>
        <h1 className="mt-3 text-4xl leading-[1.04] font-semibold tracking-[-0.035em] sm:text-5xl">
          Start free. Grow into it.
        </h1>
        <p className="mt-3.5 mb-11 max-w-xl text-muted-foreground">
          The Free plan is open now. Prices for Lawyer and Chambers, in LKR, will be announced; nothing is charged until
          then.
        </p>
        <Plans />
      </div>
    </main>
  );
}
