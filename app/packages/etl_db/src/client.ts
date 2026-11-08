// The law corpus: schema `kb` in the ETL's state database (Neon sllaw-etl), read-only from the app.
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export const db = drizzle({ client: neon(process.env.ETL_DATABASE_URL!), schema });
