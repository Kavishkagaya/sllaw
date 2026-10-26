import {
  addCaseFile, deleteFile, finishUpload, getChunk, getDoc, listCaseFiles, listChats, listMyFiles, MAX_SIZE, openCaseFile, openChat,
  openFile, removeCaseFile, reprocessCaseFile, reprocessFile, startUpload,
} from "@sllaw/services";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createCallerFactory, publicProcedure, router, signedUser, workspaceUser } from "./trpc";

const fileInput = { name: z.string().min(1).max(255), mime: z.string().max(255), size: z.number().int().positive().max(MAX_SIZE) };
const steps = z.array(z.enum(["extract", "categorize", "index"])).optional();

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
  // A case's files: the case service checks the case, then hands the file to the file service. Upload is
  // case.addFile -> PUT the bytes to uploadUrl -> file.finishUpload; the browser then follows /api/files/<id>/events.
  case: router({
    addFile: workspaceUser
      .input(z.object({ caseId: z.uuid(), ...fileInput }))
      .mutation(async ({ ctx, input }) => found(await addCaseFile(ctx.account, input.caseId, input))),
    files: workspaceUser.input(z.object({ caseId: z.uuid() })).query(async ({ ctx, input }) => found(await listCaseFiles(ctx.account, input.caseId))),
    openFile: workspaceUser
      .input(z.object({ caseId: z.uuid(), fileId: z.uuid() }))
      .query(async ({ ctx, input }) => found(await openCaseFile(ctx.account, input.caseId, input.fileId))),
    reprocessFile: workspaceUser
      .input(z.object({ caseId: z.uuid(), fileId: z.uuid(), steps }))
      .mutation(async ({ ctx, input }) => found(await reprocessCaseFile(ctx.account, input.caseId, input.fileId, input.steps))),
    removeFile: workspaceUser
      .input(z.object({ caseId: z.uuid(), fileId: z.uuid() }))
      .mutation(async ({ ctx, input }) => found((await removeCaseFile(ctx.account, input.caseId, input.fileId)) || null)),
  }),
  // A user's own files (file service, owner only), and finishing any upload the user started.
  file: router({
    startUpload: workspaceUser.input(z.object(fileInput)).mutation(({ ctx, input }) => startUpload(ctx.account, input)),
    finishUpload: workspaceUser
      .input(z.object({ fileId: z.uuid() }))
      .mutation(async ({ ctx, input }) => found(await finishUpload(ctx.account, input.fileId))),
    mine: workspaceUser.query(({ ctx }) => listMyFiles(ctx.account)),
    open: workspaceUser.input(z.object({ fileId: z.uuid() })).query(async ({ ctx, input }) => found(await openFile(ctx.account, input.fileId))),
    reprocess: workspaceUser
      .input(z.object({ fileId: z.uuid(), steps }))
      .mutation(async ({ ctx, input }) => found(await reprocessFile(ctx.account, input.fileId, input.steps))),
    delete: workspaceUser
      .input(z.object({ fileId: z.uuid() }))
      .mutation(async ({ ctx, input }) => found((await deleteFile(ctx.account, input.fileId)) || null)),
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
export { chatRoute } from "./chat";
export { fileEventsRoute, fileUploadRoute } from "./files";
export { createContext } from "./trpc";
export { clerkWebhook } from "./webhooks";
export type { ChatMessage, FileEvent, FileStatus, StepStatus } from "@sllaw/services";
