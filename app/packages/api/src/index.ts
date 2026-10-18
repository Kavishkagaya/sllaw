import { getDoc } from "@sllaw/services";
import { z } from "zod";
import { createCallerFactory, publicProcedure, router } from "./trpc";

export const appRouter = router({
  corpus: router({
    doc: publicProcedure.input(z.object({ key: z.string() })).query(({ input }) => getDoc(input.key)),
  }),
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
export { createContext } from "./trpc";
