import {
  addCaseFile,
  adminDashboard,
  adminDeletePlan,
  adminEndUserPlan,
  adminGiveUserPlan,
  adminPlans,
  adminRemoveUserLimit,
  adminSavePlan,
  adminSetDefaultPlan,
  adminSetPlanLimit,
  adminSetUserLimit,
  adminUsage,
  adminUserLimits,
  adminUsers,
  adminUserUsage,
  adminWorkspaceUsage,
  caseFileChunks,
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
  METRIC_KEYS,
  moveChat,
  openCase,
  openCaseFile,
  openChat,
  openFile,
  PERIODS,
  removeCaseFile,
  reprocessCaseFile,
  reprocessFile,
  startUpload,
  updateCase,
  usageStatus,
  workspaceUsage,
} from "@sllaw/services";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createCallerFactory,
  publicProcedure,
  router,
  signedUser,
  superAdmin,
  workspaceAdmin,
  workspaceUser,
} from "./trpc";

const fileInput = {
  name: z.string().min(1).max(255),
  mime: z.string().max(255),
  size: z.number().int().positive().max(MAX_SIZE),
};
const caseInput = { title: z.string().trim().min(1).max(200), facts: z.string().max(20_000) };
const period = z.enum(PERIODS).optional();
const metric = z.enum(METRIC_KEYS);
const max = z.number().int().nonnegative().nullable(); // null: unlimited
const note = z.string().trim().max(500).nullable();
const steps = z.array(z.enum(["extract", "categorize", "index"])).optional();

export const appRouter = router({
  user: router({
    // without is_admin: a normal user's client never learns there is an admin side
    me: signedUser.query(({ ctx }) => {
      const { isAdmin: _, ...user } = ctx.account.user;
      return { ...ctx.account, user };
    }),
  }),
  chat: router({
    // a case's chats (caseId), or the plain chats outside any case
    list: workspaceUser
      .input(z.object({ caseId: z.uuid().nullish(), limit: z.number().int().min(1).max(100).optional() }).optional())
      .query(async ({ ctx, input }) => found(await listChats(ctx.account, input?.caseId ?? null, input?.limit))),
    // chatOwner: another user's chat reads as missing
    open: workspaceUser.input(z.object({ chatId: z.uuid() })).query(async ({ ctx, input }) => {
      const c = await openChat(ctx.account, input.chatId);
      if (!c) throw new TRPCError({ code: "NOT_FOUND" });
      return c;
    }),
    // "Move to case": a plain chat goes into one of the user's cases
    move: workspaceUser
      .input(z.object({ chatId: z.uuid(), caseId: z.uuid() }))
      .mutation(async ({ ctx, input }) => found(await moveChat(ctx.account, input.chatId, input.caseId))),
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
    // the file's text as its chunks, for the citation viewer
    fileChunks: workspaceUser
      .input(z.object({ caseId: z.uuid(), fileId: z.uuid() }))
      .query(async ({ ctx, input }) => found(await caseFileChunks(ctx.account, input.caseId, input.fileId))),
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
  // What the workspace used and what it cost us (usage_events), for its admins: this month, or [from, to)
  usage: router({
    // the signed-in user's plan, each limit with what is used, and their context per day this month (/usage)
    mine: signedUser.query(({ ctx }) => usageStatus(ctx.account.user.id)),
    summary: workspaceAdmin
      .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }).optional())
      .query(({ ctx, input }) => workspaceUsage(ctx.account, input)),
  }),
  // The platform admin pages (/admin): superAdmin only; NOT_FOUND to everyone else
  admin: router({
    check: superAdmin.query(() => true),
    // plans and their limits (/admin/plans), and one user's plan and own limits (/admin/users/<id>)
    plans: router({
      list: superAdmin.query(() => adminPlans()),
      save: superAdmin
        .input(
          z.object({
            id: z.uuid().optional(),
            key: z
              .string()
              .trim()
              .regex(/^[a-z0-9_-]{1,40}$/),
            name: z.string().trim().min(1).max(80),
          }),
        )
        .mutation(({ input }) => adminSavePlan(input)),
      remove: superAdmin.input(z.object({ id: z.uuid() })).mutation(async ({ input }) => {
        if (!(await adminDeletePlan(input.id)))
          throw new TRPCError({ code: "CONFLICT", message: "The default plan cannot be deleted." });
      }),
      setDefault: superAdmin.input(z.object({ id: z.uuid() })).mutation(({ input }) => adminSetDefaultPlan(input.id)),
      setLimit: superAdmin
        .input(z.object({ planId: z.uuid(), metric, max }))
        .mutation(({ input }) => adminSetPlanLimit(input.planId, input.metric, input.max)),
    }),
    limits: router({
      user: superAdmin.input(z.object({ userId: z.uuid() })).query(({ input }) => adminUserLimits(input.userId)),
      givePlan: superAdmin
        .input(z.object({ userId: z.uuid(), planId: z.uuid(), endsAt: z.coerce.date().nullable(), note }))
        .mutation(({ ctx, input }) => adminGiveUserPlan(ctx.account.user, input)),
      endPlan: superAdmin
        .input(z.object({ userId: z.uuid(), id: z.uuid() }))
        .mutation(({ input }) => adminEndUserPlan(input.userId, input.id)),
      setUserLimit: superAdmin
        .input(z.object({ userId: z.uuid(), metric, max, expiresAt: z.coerce.date().nullable(), note }))
        .mutation(({ ctx, input }) => adminSetUserLimit(ctx.account.user, input)),
      removeUserLimit: superAdmin
        .input(z.object({ userId: z.uuid(), metric }))
        .mutation(({ input }) => adminRemoveUserLimit(input.userId, input.metric)),
    }),
    dashboard: superAdmin.input(z.object({ period }).optional()).query(({ input }) => adminDashboard(input?.period)),
    users: superAdmin.input(z.object({ period }).optional()).query(({ input }) => adminUsers(input?.period)),
    usage: superAdmin.input(z.object({ period }).optional()).query(({ input }) => adminUsage(input?.period)),
    workspace: superAdmin
      .input(z.object({ id: z.uuid(), period }))
      .query(async ({ input }) => found(await adminWorkspaceUsage(input.id, input.period))),
    user: superAdmin
      .input(z.object({ id: z.uuid(), period }))
      .query(async ({ input }) => found(await adminUserUsage(input.id, input.period))),
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
