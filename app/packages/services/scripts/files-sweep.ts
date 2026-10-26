// Runs the file pipelines on files left unfinished (a function cut off mid-step, an upload whose run never started),
// and with --stale <step>, re-runs a step on every file it was done for by another version (a new extractor,
// categorizer, embedding model or vector DB).
//   pnpm --filter @sllaw/services files-sweep
//   pnpm --filter @sllaw/services files-sweep --stale index
import { filesDone, resetSteps, STEPS, type Step, unfinishedFiles } from "@sllaw/db";
import { extractorFor } from "@sllaw/extract";
import { indexBy } from "@sllaw/search";
import { appDeps, runFile } from "../src/files";

const d = appDeps();
const i = process.argv.indexOf("--stale");
const stale = i > 0 ? (process.argv[i + 1] as Step) : null;
if (stale && !STEPS.includes(stale)) throw new Error(`--stale takes one of ${STEPS.join(", ")}`);

const todo = new Set((await unfinishedFiles(1000)).map((r) => r.id));
if (stale) {
  // an extract is stale when the extractor that reads its format now is not the one that did
  const rows =
    stale === "extract"
      ? (await filesDone("extract")).filter((r) => extractorFor(r.mime, r.name)?.by !== r.by)
      : await filesDone(stale, stale === "categorize" ? d.categorizer.by : indexBy(d.index));
  for (const { id } of rows) {
    await resetSteps(id, stale === "extract" ? STEPS : [stale]);
    todo.add(id);
  }
  console.log(`${rows.length} files set to redo ${stale}`);
}

for (const id of todo) console.log(id, await runFile(id, d));
console.log(`${todo.size} files run`);
