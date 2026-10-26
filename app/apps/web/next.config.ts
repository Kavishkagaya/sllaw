import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

// Internal packages export TypeScript source; Next compiles them. withWorkflow builds the routes that run workflow
// steps (the file pipelines, packages/services/src/files/workflow.ts).
const config = {
  transpilePackages: ["@sllaw/api", "@sllaw/ai", "@sllaw/services", "@sllaw/db", "@sllaw/etl_db", "@sllaw/search", "@sllaw/storage", "@sllaw/extract"],
} satisfies NextConfig;

export default withWorkflow(config);
