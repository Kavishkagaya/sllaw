import { putUpload } from "@sllaw/services";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { z } from "zod";
import { createContext, signedAccount } from "./trpc";

/** PUT /api/files/<id>: the bytes of an upload through the app, for a store with no direct upload (STORAGE=memory).
 *  With R2 the browser PUTs to the signed URL file.startUpload returned and this route is not used. */
export async function fileUploadRoute(req: Request, id: string) {
  try {
    if (!z.uuid().safeParse(id).success) return new Response("bad request", { status: 400 });
    const account = await signedAccount(await createContext({ headers: req.headers }));
    if (!account.workspace) return new Response("no active workspace", { status: 403 });
    const ok = await putUpload(
      { ...account, workspace: account.workspace },
      id,
      new Uint8Array(await req.arrayBuffer()),
    );
    return ok ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
  } catch (e) {
    if (e instanceof TRPCError) return new Response(e.message, { status: getHTTPStatusCodeFromError(e) });
    throw e;
  }
}
