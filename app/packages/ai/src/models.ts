// Every LLM call goes through Vercel AI Gateway (AI_GATEWAY_API_KEY locally, OIDC on Vercel): one key for every
// provider, spend per workspace (`user`), fallbacks. The model per task is config, picked later (docs/APP.md): set
// MODEL_<TASK> ("provider/model", as the gateway names it) to change one without touching code.
import { gateway, wrapLanguageModel } from "ai";

const tasks = {
  main: process.env.MODEL_MAIN ?? "deepseek/deepseek-v4-flash",
  research: process.env.MODEL_RESEARCH ?? "deepseek/deepseek-v4-flash",
  files: process.env.MODEL_FILES ?? "deepseek/deepseek-v4-flash",
};
export type Task = keyof typeof tasks;

/** The model for a task; each call is attributed to the workspace (spend per workspace sets pricing). */
export function model(task: Task, workspaceId: string) {
  return wrapLanguageModel({
    model: gateway(tasks[task]),
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          gateway: { ...params.providerOptions?.gateway, user: workspaceId, tags: [`task:${task}`] },
        },
      }),
    },
  });
}
