// Every LLM call goes through Cloudflare AI Gateway (logs, cost per workspace, cache, rate limits). The model per
// task is config, picked later (docs/APP.md): set MODEL_<TASK> to change one without touching code.
import { createDeepSeek } from "@ai-sdk/deepseek";

const tasks = {
  main: process.env.MODEL_MAIN ?? "deepseek-chat",
  research: process.env.MODEL_RESEARCH ?? "deepseek-chat",
  files: process.env.MODEL_FILES ?? "deepseek-chat",
};
export type Task = keyof typeof tasks;

const { CF_ACCOUNT_ID, CF_GATEWAY_ID } = process.env;

/** The model for a task, its gateway log entry tagged with the workspace (cost per workspace sets pricing). */
export function model(task: Task, workspaceId: string) {
  return createDeepSeek({
    baseURL: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/deepseek`,
    apiKey: process.env.DEEPSEEK_API_KEY,
    headers: { "cf-aig-metadata": JSON.stringify({ workspace: workspaceId, task }) },
  })(tasks[task]);
}
