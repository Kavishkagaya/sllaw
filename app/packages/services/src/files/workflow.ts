// The file pipelines as a Vercel Workflow: each step is a durable step with its own function invocation and time
// limit, retried on a throw (a model timeout, a Zilliz hiccup); the run resumes after a crash. The row stays the
// source of truth: every step goes through runStep, which claims it and writes its end, so the sweep and a retry by
// hand see the same states. extract first, then categorize and index side by side.

import type { Step } from "@sllaw/db";
import { getStepMetadata } from "workflow";
import { appDeps } from "./deps";
import { runStep } from "./pipeline";

const MAX_RETRIES = 2; // 3 attempts; after the last the step is recorded failed (file.reprocess runs it again)

export async function fileWorkflow(fileId: string) {
  "use workflow";
  const extract = await extractStep(fileId);
  if (extract !== "done" && extract !== null) return { extract };
  const [categorize, index] = await Promise.all([categorizeStep(fileId), indexStep(fileId)]);
  return { extract, categorize, index };
}

async function step(fileId: string, s: Step) {
  const { attempt } = getStepMetadata(); // from 1
  return runStep(fileId, s, appDeps(), { retriesLeft: attempt <= MAX_RETRIES });
}

async function extractStep(fileId: string) {
  "use step";
  return step(fileId, "extract");
}
extractStep.maxRetries = MAX_RETRIES;

async function categorizeStep(fileId: string) {
  "use step";
  return step(fileId, "categorize");
}
categorizeStep.maxRetries = MAX_RETRIES;

async function indexStep(fileId: string) {
  "use step";
  return step(fileId, "index");
}
indexStep.maxRetries = MAX_RETRIES;
