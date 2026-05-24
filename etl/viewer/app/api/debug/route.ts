import { db } from "@/lib/db";
import { acts } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET() {
  const [act] = await db.select().from(acts).where(eq(acts.id, 109)).limit(1);
  return NextResponse.json({
    id: act?.id,
    rawJsonType: typeof act?.rawJson,
    rawJsonNull: act?.rawJson === null,
    rawJsonKeys: act?.rawJson ? Object.keys(act.rawJson as object) : null,
    rawJsonSize: act?.rawJson ? JSON.stringify(act.rawJson).length : 0,
  });
}
