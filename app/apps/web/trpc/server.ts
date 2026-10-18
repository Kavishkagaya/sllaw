// tRPC in server components: the same router, called in-process with this request's session.
import { createCaller, createContext } from "@sllaw/api";
import { headers } from "next/headers";
import { cache } from "react";

export const serverApi = cache(async () => createCaller(await createContext({ headers: await headers() })));
