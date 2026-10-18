import { chatRoute } from "@sllaw/api";
import { after } from "next/server";

export const POST = (req: Request) => chatRoute(req, after);

export const maxDuration = 300; // an answer runs up to 14 agent steps, a few minutes at most; after() (the final save) runs within it
