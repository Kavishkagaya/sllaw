// Query vectors: bge-m3 on Workers AI, the model etl/embed.py built the index with, so query and chunk vectors match.
const MODEL = "@cf/baai/bge-m3";

export async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: texts }),
    signal,
  });
  if (!r.ok)
    throw Object.assign(new Error(`embed ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: r.status });
  const data: number[][] = (await r.json()).result.data;
  if (data.length !== texts.length) throw new Error(`embed: ${data.length} vectors for ${texts.length} texts`);
  return data;
}
