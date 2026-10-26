import { myFileEvents, putUpload } from "@sllaw/services";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { z } from "zod";
import { createContext, signedAccount } from "./trpc";

async function workspaceAccount(req: Request) {
  const account = await signedAccount(await createContext({ headers: req.headers }));
  return account.workspace ? { ...account, workspace: account.workspace } : null;
}

const asResponse = (e: unknown) => {
  if (e instanceof TRPCError) return new Response(e.message, { status: getHTTPStatusCodeFromError(e) });
  throw e;
};

/** PUT /api/files/<id>: the bytes of an upload through the app, for a store with no direct upload (STORAGE=memory).
 *  With R2 the browser PUTs to the signed URL the upload's start returned and this route is not used. */
export async function fileUploadRoute(req: Request, id: string) {
  try {
    if (!z.uuid().safeParse(id).success) return new Response("bad request", { status: 400 });
    const account = await workspaceAccount(req);
    if (!account) return new Response("no active workspace", { status: 403 });
    const ok = await putUpload(account, id, new Uint8Array(await req.arrayBuffer()));
    return ok ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
  } catch (e) {
    return asResponse(e);
  }
}

/** GET /api/files/<id>/events: the file's processing states as server-sent events (EventSource). The browser sends
 *  Last-Event-ID when it reconnects, and the stream resumes after it. The uploader's own files only for now. */
export async function fileEventsRoute(req: Request, id: string) {
  try {
    if (!z.uuid().safeParse(id).success) return new Response("bad request", { status: 400 });
    const account = await workspaceAccount(req);
    if (!account) return new Response("no active workspace", { status: 403 });
    const last = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after") ?? NaN);
    const stream = await myFileEvents(account, id, Number.isInteger(last) ? last : undefined);
    if (!stream) return new Response("not found", { status: 404 });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    return asResponse(e);
  }
}
