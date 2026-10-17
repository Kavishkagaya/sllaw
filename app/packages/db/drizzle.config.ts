import { defineConfig } from "drizzle-kit";

// Only the app's tables: docs/chunks/links (src/corpus.ts) belong to etl.publish, which truncates them each run.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/app.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
