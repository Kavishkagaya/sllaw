import { initTRPC } from "@trpc/server";
import superjson from "superjson";

// ponytail: no auth yet; Clerk (userId, workspaceId) goes in here with #14, plus a protectedProcedure.
export const createContext = async (opts: { headers: Headers }) => ({ headers: opts.headers });

const t = initTRPC.context<Awaited<ReturnType<typeof createContext>>>().create({ transformer: superjson });
export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
