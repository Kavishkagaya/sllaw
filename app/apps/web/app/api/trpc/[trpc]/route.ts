import { appRouter, createContext } from "@sllaw/api";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext({ headers: req.headers }),
  });

export { handler as GET, handler as POST };
// a subscription (file.events) streams up to 280 s (sse.maxDurationMs in api/trpc.ts), then the browser reconnects
export const maxDuration = 300;
