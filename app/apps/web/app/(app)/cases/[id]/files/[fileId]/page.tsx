import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { docTypeLabel, fmtDate, fmtSize } from "@/lib/format";
import { orNotFound, serverApi } from "../../../../../../trpc/server";
import { FileActions } from "./file-actions";

// The card the categorizer wrote (meta on the row; the summary from the store).
type Meta = {
  title?: string;
  language?: string;
  parties?: { name: string; role: string }[];
  dates?: { date: string; what: string }[];
  court?: string | null;
  caseNumbers?: string[];
  lawsCited?: string[];
  tags?: string[];
};

const LANGUAGE: Record<string, string> = { en: "English", si: "Sinhala", ta: "Tamil", mixed: "Mixed" };

// /cases/<id>/files/<fileId>: what the file is and says, as read by the categorizer, and where its processing is.
export default async function CaseFilePage({ params }: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await params;
  const api = await serverApi();
  const [c, v] = await Promise.all([
    orNotFound(api.case.open({ caseId: id })),
    orNotFound(api.case.openFile({ caseId: id, fileId })),
  ]);
  const f = v.file;
  const m = (f.meta ?? {}) as Meta;
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        crumbs={[
          { label: "Cases", href: "/cases" },
          { label: c.title, href: `/cases/${c.id}` },
          { label: m.title || f.name },
        ]}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
          {f.category && <Badge variant="secondary">{docTypeLabel(f.category)}</Badge>}
          <h1 className="mt-2 font-serif text-3xl leading-tight font-semibold tracking-tight">{m.title || f.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {[
              m.title && f.name,
              f.pages != null && `${f.pages} ${f.pages === 1 ? "page" : "pages"}`,
              fmtSize(f.size),
              m.language && LANGUAGE[m.language],
              `added ${fmtDate(f.createdAt)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>

          <FileActions caseId={c.id} fileId={f.id} name={f.name} status={v.status} downloadUrl={v.downloadUrl} />

          {v.summary && (
            <>
              <Separator className="my-8" />
              <h2 className="mb-2 text-sm font-medium">Summary</h2>
              <p className="font-serif leading-relaxed">{v.summary}</p>
            </>
          )}

          {f.category && (
            <dl className="mt-8 grid gap-x-8 gap-y-6 sm:grid-cols-2">
              {m.court && <Field label="Court">{m.court}</Field>}
              {!!m.caseNumbers?.length && <Field label="Case numbers">{m.caseNumbers.join(", ")}</Field>}
              {!!m.parties?.length && (
                <Field label="Parties">
                  <ul className="space-y-0.5">
                    {m.parties.map((p, i) => (
                      <li key={i}>
                        {p.name} <span className="text-muted-foreground">({p.role})</span>
                      </li>
                    ))}
                  </ul>
                </Field>
              )}
              {!!m.dates?.length && (
                <Field label="Dates">
                  <ul className="space-y-0.5">
                    {m.dates.map((d, i) => (
                      <li key={i}>
                        <span className="tabular-nums">{d.date}</span>{" "}
                        <span className="text-muted-foreground">{d.what}</span>
                      </li>
                    ))}
                  </ul>
                </Field>
              )}
              {!!m.lawsCited?.length && (
                <Field label="Laws cited" wide>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {m.lawsCited.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                </Field>
              )}
              {!!m.tags?.length && (
                <Field label="Tags" wide>
                  <div className="flex flex-wrap gap-1">
                    {m.tags.map((t) => (
                      <Badge key={t} variant="outline">
                        {t}
                      </Badge>
                    ))}
                  </div>
                </Field>
              )}
            </dl>
          )}
        </div>
      </main>
    </div>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
