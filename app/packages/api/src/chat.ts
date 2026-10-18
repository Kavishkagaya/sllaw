import { sendMessage } from "@sllaw/services";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createContext, signedAccount } from "./trpc";

// Only the new user message, text only: history comes from the database, so a client cannot forge tool outputs.
const body = z.object({
  id: z.uuid(),
  message: z.object({
    id: z.string().min(1).max(100),
    role: z.literal("user"),
    parts: z.array(z.object({ type: z.literal("text"), text: z.string().min(1).max(20_000) })).min(1).max(10),
  }),
});

/** POST /api/chat: one turn of a chat (useChat), streamed. Outside tRPC because it streams AI SDK UI messages. */
/** req.signal ends the run when the client stops (useChat's stop aborts the request) or leaves; waitUntil (Next's
 *  after()) lets the answer so far be stored after that, when no response is left to keep the function alive. */
export async function chatRoute(req: Request, waitUntil: (p: Promise<unknown>) => void) {
  try {
    const account = await signedAccount(await createContext({ headers: req.headers }));
    if (!account.workspace) return new Response("no active workspace", { status: 403 });
    const input = body.safeParse(await req.json().catch(() => null));
    if (!input.success) return new Response("bad request", { status: 400 });
    const res = await sendMessage({ ...account, workspace: account.workspace }, input.data.id, input.data.message, waitUntil, req.signal);
    return res ?? new Response("not found", { status: 404 });
  } catch (e) {
    if (e instanceof TRPCError) return new Response(e.message, { status: getHTTPStatusCodeFromError(e) });
    throw e;
  }
}
