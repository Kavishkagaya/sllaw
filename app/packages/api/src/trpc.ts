import { auth } from "@clerk/nextjs/server";
import { accountOf, FileBusy, LimitReached, OfficeError } from "@sllaw/services";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";

// The Clerk session (Clerk ids); procedures turn it into our account (our ids).
export const createContext = async (opts: { headers: Headers }) => {
  const { userId, orgId } = await auth();
  return { headers: opts.headers, clerk: { userId, orgId: orgId ?? null } };
};

type Context = Awaited<ReturnType<typeof createContext>>;
const t = initTRPC.context<Context>().create({ transformer: superjson });
export const router = t.router;

/** A plan limit reached in a service (LimitReached) is TOO_MANY_REQUESTS (429), an OfficeError BAD_REQUEST (400),
 *  each with its message for the user. */
const base = t.procedure.use(async ({ next }) => {
  const r = await next();
  if (!r.ok && r.error.cause instanceof LimitReached)
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: r.error.cause.message, cause: r.error.cause });
  // a case office change that cannot be made (a pinned widget, an item gone, bad data): its message for the user
  if (!r.ok && r.error.cause instanceof OfficeError)
    throw new TRPCError({ code: "BAD_REQUEST", message: r.error.cause.message, cause: r.error.cause });
  // a file being read again for a new type: try later
  if (!r.ok && r.error.cause instanceof FileBusy)
    throw new TRPCError({ code: "CONFLICT", message: (r.error.cause as FileBusy).message, cause: r.error.cause });
  return r;
});
export const publicProcedure = base;
export const createCallerFactory = t.createCallerFactory;

/** A signed-in user: ctx.account = our user, their workspaces (with role) and the active workspace (or null). */
export const signedUser = base.use(async ({ ctx, next }) =>
  next({ ctx: { ...ctx, account: await signedAccount(ctx) } }),
);

/** signedUser with an active workspace: ctx.account.workspace is set. */
export const workspaceUser = signedUser.use(({ ctx, next }) => {
  const { workspace } = ctx.account;
  if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "no active workspace" });
  return next({ ctx: { ...ctx, account: { ...ctx.account, workspace } } });
});

/** Platform staff (users.is_admin). To anyone else an admin procedure does not exist: NOT_FOUND, as for a path
 *  that is not there, never FORBIDDEN. */
export const superAdmin = signedUser.use(({ ctx, next }) => {
  if (!ctx.account.user.isAdmin) throw new TRPCError({ code: "NOT_FOUND" });
  return next();
});

/** workspaceUser who is an admin of the active workspace (Clerk org role admin). */
export const workspaceAdmin = workspaceUser.use(({ ctx, next }) => {
  if (ctx.account.workspace.role !== "admin")
    throw new TRPCError({ code: "FORBIDDEN", message: "workspace admins only" });
  return next();
});

/** The account behind a Clerk session, for procedures and for routes outside tRPC (the chat stream). */
export async function signedAccount(ctx: Context) {
  if (!ctx.clerk.userId) throw new TRPCError({ code: "UNAUTHORIZED" });
  const account = await accountOf(ctx.clerk.userId, ctx.clerk.orgId);
  // ponytail: right after sign-up the webhook may not have landed yet; the client retries. Sync from Clerk's API
  // here if that wait shows up in practice.
  if (!account) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "account not synced yet" });
  return account;
}
