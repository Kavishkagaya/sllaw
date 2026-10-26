// The file pipelines as a Vercel Workflow: each step is a durable step with its own function invocation and time
// limit, retried on a throw (a model timeout, a Zilliz hiccup) or when its function was cut off; the run resumes
// after a crash. The row stays the source of truth: every step goes through runStep, which claims it and writes its
// end. extract first, then categorize and index side by side.
// Every state runStep writes also goes to the run's stream (getWritable): the events route reads it and sends each
// one to the browser as a server-sent event. The last step closes the stream, which ends the browser's connection.

import type { Step } from "@sllaw/db";
import { getStepMetadata, getWorkflowMetadata, getWritable } from "workflow";
import { appDeps } from "./deps";
import { type FileEvent, runStep, type StateWriter } from "./pipeline";

const MAX_RETRIES = 2; // 3 attempts; after the last the step is recorded failed (the user retries it from the UI)

export async function fileWorkflow(fileId: string) {
  "use workflow";
  // passed to each step: a retry of a step this run left running (its function cut off) claims it back at once
  const { workflowRunId: runId } = getWorkflowMetadata();
  try {
    const extract = await extractStep(fileId, runId);
    if (extract !== "done" && extract !== null) return { extract };
    const [categorize, index] = await Promise.all([categorizeStep(fileId, runId), indexStep(fileId, runId)]);
    return { extract, categorize, index };
  } finally {
    await closeStream();
  }
}

/** The run's stream as a StateWriter: one chunk per state change. */
const streamWriter = (): StateWriter => ({
  async write(e) {
    const w = getWritable<FileEvent>().getWriter();
    try {
      await w.write(e);
    } finally {
      w.releaseLock();
    }
  },
});

/** busy: a newer run (a retry from the UI) has the step; this run leaves it to that one. */
async function step(fileId: string, s: Step, runId: string) {
  const { attempt } = getStepMetadata(); // from 1
  const r = await runStep(fileId, s, appDeps(), { retriesLeft: attempt <= MAX_RETRIES, writer: streamWriter(), runId });
  return r === "busy" ? null : r;
}

async function extractStep(fileId: string, runId: string) {
  "use step";
  return step(fileId, "extract", runId);
}
extractStep.maxRetries = MAX_RETRIES;

async function categorizeStep(fileId: string, runId: string) {
  "use step";
  return step(fileId, "categorize", runId);
}
categorizeStep.maxRetries = MAX_RETRIES;

async function indexStep(fileId: string, runId: string) {
  "use step";
  return step(fileId, "index", runId);
}
indexStep.maxRetries = MAX_RETRIES;

async function closeStream() {
  "use step";
  await getWritable<FileEvent>().close();
}
