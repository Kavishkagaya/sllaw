import { defineConfig } from "drizzle-kit";

// The app database only; the corpus (etl_db) has no migrations here.
if (!process.env.DATABASE_URL) process.loadEnvFile("../../apps/web/.env.local");
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
