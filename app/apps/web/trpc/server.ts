// tRPC in server components: the same router, called in-process with this request's session.
import { createCaller, createContext } from "@sllaw/api";
import { TRPCError } from "@trpc/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";

export const serverApi = cache(async () => createCaller(await createContext({ headers: await headers() })));

/** A server call whose missing (or malformed id) result is the 404 page. */
export const orNotFound = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    if (e instanceof TRPCError && (e.code === "NOT_FOUND" || e.code === "BAD_REQUEST")) notFound();
    throw e;
  });
