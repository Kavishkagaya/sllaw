import { auth } from "@clerk/nextjs/server";
import { accountOf } from "@sllaw/services";
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
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;

/** A signed-in user: ctx.account = our user, their workspaces (with role) and the active workspace (or null). */
export const signedUser = t.procedure.use(async ({ ctx, next }) => next({ ctx: { ...ctx, account: await signedAccount(ctx) } }));

/** signedUser with an active workspace: ctx.account.workspace is set. */
export const workspaceUser = signedUser.use(({ ctx, next }) => {
  const { workspace } = ctx.account;
  if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "no active workspace" });
  return next({ ctx: { ...ctx, account: { ...ctx.account, workspace } } });
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
