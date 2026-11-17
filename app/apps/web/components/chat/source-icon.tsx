// Each kind of source has its own icon wherever a citation shows (the answer's chip, the Sources panel, the viewer,
// the trail): a law, a regulation (gazette), a judgment, the lawyer's own case paper (chat-regulations d8).
import { FileText, Gavel, Landmark, ScrollText } from "lucide-react";

export type SourceKind = "law" | "regulation" | "judgment" | "file";

/** A corpus key's kind: ca:/sc: judgments, gazette: regulations, every other key a law. */
export const sourceKind = (docKey: string | null | undefined): SourceKind =>
  docKey && /^(ca|sc):/.test(docKey) ? "judgment" : docKey?.startsWith("gazette:") ? "regulation" : "law";

export const SOURCE_ICON = { law: Landmark, regulation: ScrollText, judgment: Gavel, file: FileText } as const;

export function SourceIcon({ kind, className }: { kind: SourceKind; className?: string }) {
  const Icon = SOURCE_ICON[kind];
  return <Icon aria-hidden className={className} />;
}
