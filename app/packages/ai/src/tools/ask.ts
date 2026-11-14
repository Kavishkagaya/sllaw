// The facts the agent asks the lawyer for (a case chat only): each question shows under the answer as a chip that
// puts it in the lawyer's reply box. Nothing is stored or sent: the lawyer answers in their own words.
import { tool } from "ai";
import { z } from "zod";

export const askTools = () => ({
  ask: tool({
    description:
      "Shows the lawyer the facts you need from them, each as a short question they can tap to answer. Call it once, " +
      "after your answer, when the answer names facts that are missing.",
    inputSchema: z.object({
      questions: z.array(z.string().min(1).max(200)).min(1).max(8).describe("each missing fact as a short question"),
    }),
    execute: async ({ questions }) => ({ questions }),
  }),
});
