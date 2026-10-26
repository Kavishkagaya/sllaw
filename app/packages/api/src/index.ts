import {
  addCaseFile,
  createCase,
  deleteCase,
  deleteFile,
  finishUpload,
  getChunk,
  getDoc,
  listCaseFiles,
  listCases,
  listChats,
  listMyFiles,
  MAX_SIZE,
  openCase,
  openCaseFile,
  openChat,
  openFile,
  removeCaseFile,
  reprocessCaseFile,
  reprocessFile,
  startUpload,
  updateCase,
} from "@sllaw/services";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createCallerFactory, publicProcedure, router, signedUser, workspaceUser } from "./trpc";

const fileInput = {
  name: z.string().min(1).max(255),
  mime: z.string().max(255),
  size: z.number().int().positive().max(MAX_SIZE),
};
const caseInput = { title: z.string().trim().min(1).max(200), facts: z.string().max(20_000) };
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
  // Cases (the case service decides who may see and change one) and their files: the case service checks the case,
  // then hands the file to the file service. Upload is
  // case.addFile -> PUT the bytes to uploadUrl -> file.finishUpload; the browser then follows /api/files/<id>/events.
  case: router({
    list: workspaceUser.query(({ ctx }) => listCases(ctx.account)),
    create: workspaceUser.input(z.object(caseInput)).mutation(({ ctx, input }) => createCase(ctx.account, input)),
    open: workspaceUser
      .input(z.object({ caseId: z.uuid() }))
      .query(async ({ ctx, input }) => found(await openCase(ctx.account, input.caseId))),
    update: workspaceUser
      .input(z.object({ caseId: z.uuid(), ...caseInput }))
      .mutation(async ({ ctx, input }) => found(await updateCase(ctx.account, input.caseId, input))),
    // with its files and chats; refused while a file is being processed
    delete: workspaceUser
      .input(z.object({ caseId: z.uuid() }))
      .mutation(async ({ ctx, input }) => removed(await deleteCase(ctx.account, input.caseId), CASE_BUSY)),
    addFile: workspaceUser
      .input(z.object({ caseId: z.uuid(), ...fileInput }))
      .mutation(async ({ ctx, input }) => found(await addCaseFile(ctx.account, input.caseId, input))),
    files: workspaceUser
      .input(z.object({ caseId: z.uuid() }))
      .query(async ({ ctx, input }) => found(await listCaseFiles(ctx.account, input.caseId))),
    openFile: workspaceUser
      .input(z.object({ caseId: z.uuid(), fileId: z.uuid() }))
      .query(async ({ ctx, input }) => found(await openCaseFile(ctx.account, input.caseId, input.fileId))),
    reprocessFile: workspaceUser
      .input(z.object({ caseId: z.uuid(), fileId: z.uuid(), steps }))
      .mutation(async ({ ctx, input }) =>
        found(await reprocessCaseFile(ctx.account, input.caseId, input.fileId, input.steps)),
      ),
    removeFile: workspaceUser
      .input(z.object({ caseId: z.uuid(), fileId: z.uuid() }))
      .mutation(async ({ ctx, input }) => removed(await removeCaseFile(ctx.account, input.caseId, input.fileId))),
  }),
  // A user's own files (file service, owner only), and finishing any upload the user started.
  file: router({
    startUpload: workspaceUser.input(z.object(fileInput)).mutation(({ ctx, input }) => startUpload(ctx.account, input)),
    finishUpload: workspaceUser
      .input(z.object({ fileId: z.uuid() }))
      .mutation(async ({ ctx, input }) => found(await finishUpload(ctx.account, input.fileId))),
    mine: workspaceUser.query(({ ctx }) => listMyFiles(ctx.account)),
    open: workspaceUser
      .input(z.object({ fileId: z.uuid() }))
      .query(async ({ ctx, input }) => found(await openFile(ctx.account, input.fileId))),
    reprocess: workspaceUser
      .input(z.object({ fileId: z.uuid(), steps }))
      .mutation(async ({ ctx, input }) => found(await reprocessFile(ctx.account, input.fileId, input.steps))),
    delete: workspaceUser
      .input(z.object({ fileId: z.uuid() }))
      .mutation(async ({ ctx, input }) => removed(await deleteFile(ctx.account, input.fileId))),
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

/** A delete: missing reads as NOT_FOUND; a file a run still works on as CONFLICT (delete it once its steps end). */
const FILE_BUSY = "The file is still being processed. Delete it once it is done or has failed.";
const CASE_BUSY =
  "Some of the case's files are still being processed. Delete the case once they are done or have failed.";

function removed(r: "removed" | "busy" | null, busy = FILE_BUSY) {
  if (r === "busy") throw new TRPCError({ code: "CONFLICT", message: busy });
  return found(r);
}

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
export type { ChatMessage, FileEvent, FileStatus, StepStatus } from "@sllaw/services";
export { chatRoute } from "./chat";
export { fileEventsRoute, fileUploadRoute } from "./files";
export { createContext } from "./trpc";
export { clerkWebhook } from "./webhooks";
