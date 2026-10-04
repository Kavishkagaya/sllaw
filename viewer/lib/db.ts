import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parse as parsePgUrl } from "pg-connection-string";
import dns from "dns/promises";
import * as schema from "./schema";

async function makePool(): Promise<Pool> {
  const url = process.env.DATABASE_URL!;
  const config = parsePgUrl(url);
  const host = config.host as string;

  // Node.js v20 happy-eyeballs tries IPv6 addresses that aren't reachable on
  // this machine and the whole attempt ETIMEDOUT. Force IPv4 by resolving
  // upfront and passing the IP, keeping servername for TLS SNI.
  let resolvedHost = host;
  try {
    const addrs = await dns.resolve4(host);
    resolvedHost = addrs[0];
  } catch {
    // fall back to original hostname if DNS resolution fails
  }

  return new Pool({
    ...config,
    host: resolvedHost,
    port: config.port ? Number(config.port) : 5432,
    database: config.database ?? undefined,
    ssl: config.ssl
      ? { ...(config.ssl as object), servername: host }
      : undefined,
  });
}

const poolPromise = makePool();

export const db = drizzle(await poolPromise, { schema });
