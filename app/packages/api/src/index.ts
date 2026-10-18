import { getChunk, getDoc, listChats, openChat } from "@sllaw/services";
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
  corpus: router({
    doc: publicProcedure.input(z.object({ key: z.string() })).query(({ input }) => getDoc(input.key)),
    chunk: signedUser
      .input(z.object({ chunkId: z.number().int().positive(), date: z.iso.date().optional() }))
      .query(({ input }) => getChunk(input.chunkId, input.date)),
  }),
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
export { chatRoute } from "./chat";
export { createContext } from "./trpc";
export { clerkWebhook } from "./webhooks";
export type { ChatMessage } from "@sllaw/services";
