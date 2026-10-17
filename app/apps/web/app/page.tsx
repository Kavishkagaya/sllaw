import { createCaller } from "@sllaw/api";
import { headers } from "next/headers";

// ponytail: wiring check only (web → api → services → db); replaced by the app's first real page.
export default async function Home() {
  const api = createCaller({ headers: await headers() });
  const doc = await api.corpus.doc({ key: "constitution" });
  return <main>{doc ? `${doc.title}: ${doc.chunks.length} chunks` : "constitution not found"}</main>;
}
