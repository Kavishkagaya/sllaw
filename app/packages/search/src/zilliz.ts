// The Zilliz Cloud REST client (v2), shared by the law and user-file collections.
import { meter } from "@sllaw/usage";

export async function zilliz(path: string, body: object, signal?: AbortSignal) {
  const r = await fetch(`${process.env.ZILLIZ_URI}/v2/vectordb/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.ZILLIZ_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error(`zilliz ${path}: ${d.code} ${d.message}`);
  // serverless clusters answer with the call's cost in vCU (`cost`); no dollar price until we leave the free tier
  const rows = Array.isArray(d.data) ? d.data.length : (d.data?.insertCount ?? d.data?.deleteCount ?? 0);
  meter({
    kind: "vector",
    task: path,
    model: "zilliz",
    quantity: { calls: 1, rows, ...(typeof d.cost === "number" && { vcu: d.cost }) },
  });
  return d.data;
}
