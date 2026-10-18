import type { NextConfig } from "next";

// Internal packages export TypeScript source; Next compiles them.
export default { transpilePackages: ["@sllaw/api", "@sllaw/ai", "@sllaw/services", "@sllaw/db", "@sllaw/etl_db", "@sllaw/search"] } satisfies NextConfig;
