import { verifyWebhook } from "@clerk/backend/webhooks";
import { syncClerkEvent } from "@sllaw/services";

/** POST /api/webhooks/clerk: verified with CLERK_WEBHOOK_SIGNING_SECRET (Svix). A 5xx makes Clerk retry. */
export async function clerkWebhook(req: Request) {
  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch {
    return new Response("bad signature", { status: 400 });
  }
  await syncClerkEvent(evt);
  return new Response("ok");
}
