// Query vectors: bge-m3 on Workers AI, the model etl/embed.py built the index with, so query and chunk vectors match.
import { meter, PRICES, roughTokens } from "@sllaw/usage";

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
  const { result } = await r.json();
  const data: number[][] = result.data;
  if (data.length !== texts.length) throw new Error(`embed: ${data.length} vectors for ${texts.length} texts`);
  // Workers AI may return no token count: then ~4 characters a token
  const chars = texts.reduce((a, t) => a + t.length, 0);
  const tokens: number = result.usage?.prompt_tokens ?? roughTokens(chars);
  meter({
    kind: "embed",
    task: "embed",
    model: MODEL,
    quantity: { texts: texts.length, chars, tokens },
    costUsd: tokens * PRICES.bgeM3Token,
    estimated: true,
  });
  return data;
}
