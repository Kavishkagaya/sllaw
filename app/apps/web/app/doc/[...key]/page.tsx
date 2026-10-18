import { notFound } from "next/navigation";
import { serverApi } from "../../../trpc/server";

// /doc/act:9/2023#c123: a law in full, each chunk anchored by id so citations open at it.
export default async function DocPage({ params }: { params: Promise<{ key: string[] }> }) {
  const key = (await params).key.map(decodeURIComponent).join("/");
  const doc = await (await serverApi()).corpus.doc({ key });
  if (!doc) notFound();
  return (
    <main className="doc">
      <h1>{doc.title ?? doc.key}</h1>
      <p className="muted">{doc.key}{doc.commenced ? ` · commenced ${doc.commenced}` : ""}</p>
      {doc.chunks.map((c) => (
        <section key={c.id} id={`c${c.id}`}>
          {c.path && <p className="muted">{c.path}</p>}
          <div className="text">{c.text}</div>
        </section>
      ))}
    </main>
  );
}
