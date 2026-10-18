import { getDoc } from "@sllaw/services";
import { z } from "zod";
import { createCallerFactory, publicProcedure, router, signedUser } from "./trpc";

export const appRouter = router({
  user: router({
    me: signedUser.query(({ ctx }) => ctx.account),
  }),
  corpus: router({
    doc: publicProcedure.input(z.object({ key: z.string() })).query(({ input }) => getDoc(input.key)),
  }),
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
export { createContext } from "./trpc";
export { clerkWebhook } from "./webhooks";
