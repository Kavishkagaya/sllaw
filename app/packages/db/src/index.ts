import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as app from "./app";
import * as corpus from "./corpus";

export const db = drizzle({ client: neon(process.env.DATABASE_URL!), schema: { ...app, ...corpus } });
export * from "./app";
export * from "./corpus";
export * from "drizzle-orm"; // eq, and, sql ...: one drizzle version for every package
