import { auth } from "@clerk/nextjs/server";
import { accountOf } from "@sllaw/services";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";

// The Clerk session (Clerk ids); procedures turn it into our account (our ids).
export const createContext = async (opts: { headers: Headers }) => {
  const { userId, orgId } = await auth();
  return { headers: opts.headers, clerk: { userId, orgId: orgId ?? null } };
};

const t = initTRPC.context<Awaited<ReturnType<typeof createContext>>>().create({ transformer: superjson });
export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;

/** A signed-in user: ctx.account = our user, their workspaces (with role) and the active workspace (or null). */
export const signedUser = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.clerk.userId) throw new TRPCError({ code: "UNAUTHORIZED" });
  const account = await accountOf(ctx.clerk.userId, ctx.clerk.orgId);
  // ponytail: right after sign-up the webhook may not have landed yet; the client retries. Sync from Clerk's API
  // here if that wait shows up in practice.
  if (!account) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "account not synced yet" });
  return next({ ctx: { ...ctx, account } });
});
