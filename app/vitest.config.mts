// Unit tests for every package: *.test.ts next to the code. In memory only: no database, R2, model or Zilliz (checks
// against real services stay scripts: services check-accounts, eval-chat, search eval).
//   pnpm test         all, once
//   pnpm test:watch   on change
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true, // a package with no tests yet is not a failure
  },
});
