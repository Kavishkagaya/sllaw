// The Zilliz Cloud REST client (v2), shared by the law and user-file collections.
export async function zilliz(path: string, body: object) {
  const r = await fetch(`${process.env.ZILLIZ_URI}/v2/vectordb/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.ZILLIZ_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error(`zilliz ${path}: ${d.code} ${d.message}`);
  return d.data;
}
