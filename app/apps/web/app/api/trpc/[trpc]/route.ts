import { appRouter, createContext } from "@sllaw/api";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { after } from "next/server";

const handler = (req: Request) =>
  fetchRequestHandler({ endpoint: "/api/trpc", req, router: appRouter, createContext: () => createContext({ headers: req.headers, waitUntil: after }) });

export { handler as GET, handler as POST };

// file.finishUpload runs the file's pipelines in after(), within this limit: extract, one model call, embedding
export const maxDuration = 300;
