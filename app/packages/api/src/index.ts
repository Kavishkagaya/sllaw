import {
  deleteFile,
  finishUpload,
  getChunk,
  getDoc,
  listCaseFiles,
  listChats,
  listMyFiles,
  MAX_SIZE,
  openChat,
  openFile,
  reprocessFile,
  searchFiles,
  startUpload,
} from "@sllaw/services";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createCallerFactory, publicProcedure, router, signedUser, workspaceUser } from "./trpc";

export const appRouter = router({
  user: router({
    me: signedUser.query(({ ctx }) => ctx.account),
  }),
  chat: router({
    list: workspaceUser.query(({ ctx }) => listChats(ctx.account)),
    // chatOwner: another user's chat reads as missing
    open: workspaceUser.input(z.object({ chatId: z.uuid() })).query(async ({ ctx, input }) => {
      const c = await openChat(ctx.account, input.chatId);
      if (!c) throw new TRPCError({ code: "NOT_FOUND" });
      return c;
    }),
  }),
  // Files (docs/APP.md, Files): upload is startUpload -> PUT the bytes to uploadUrl -> finishUpload, which starts
  // the pipelines. Case files: the case author only for now (services/files, caseOf).
  file: router({
    startUpload: workspaceUser
      .input(
        z.object({
          name: z.string().min(1).max(255),
          mime: z.string().max(255),
          size: z.number().int().positive().max(MAX_SIZE),
          use: z.enum(["case", "private", "asset"]),
          caseId: z.uuid().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => found(await startUpload(ctx.account, input))),
    finishUpload: workspaceUser
      .input(z.object({ fileId: z.uuid() }))
      .mutation(async ({ ctx, input }) => found(await finishUpload(ctx.account, input.fileId))),
    ofCase: workspaceUser
      .input(z.object({ caseId: z.uuid() }))
      .query(async ({ ctx, input }) => found(await listCaseFiles(ctx.account, input.caseId))),
    mine: workspaceUser.query(({ ctx }) => listMyFiles(ctx.account)),
    open: workspaceUser
      .input(z.object({ fileId: z.uuid() }))
      .query(async ({ ctx, input }) => found(await openFile(ctx.account, input.fileId))),
    reprocess: workspaceUser
      .input(z.object({ fileId: z.uuid(), steps: z.array(z.enum(["extract", "categorize", "index"])).optional() }))
      .mutation(async ({ ctx, input }) => found(await reprocessFile(ctx.account, input.fileId, input.steps))),
    delete: workspaceUser
      .input(z.object({ fileId: z.uuid() }))
      .mutation(async ({ ctx, input }) => found((await deleteFile(ctx.account, input.fileId)) || null)),
    search: workspaceUser
      .input(
        z.object({
          query: z.string().min(1).max(2000),
          caseId: z.uuid().optional(),
          docTypes: z.array(z.string().max(32)).max(10).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }),
      )
      .query(({ ctx, input }) => searchFiles(ctx.account, input.query, input)),
  }),
  corpus: router({
    doc: publicProcedure.input(z.object({ key: z.string() })).query(({ input }) => getDoc(input.key)),
    chunk: signedUser
      .input(z.object({ chunkId: z.number().int().positive(), date: z.iso.date().optional() }))
      .query(({ input }) => getChunk(input.chunkId, input.date)),
  }),
});

/** null (someone else's, or not there) reads as missing. */
function found<T>(x: T | null): T {
  if (x == null) throw new TRPCError({ code: "NOT_FOUND" });
  return x;
}

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
export type { ChatMessage } from "@sllaw/services";
export { chatRoute } from "./chat";
export { fileUploadRoute } from "./files";
export { createContext } from "./trpc";
export { clerkWebhook } from "./webhooks";
