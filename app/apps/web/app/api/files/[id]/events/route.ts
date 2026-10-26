import { fileEventsRoute } from "@sllaw/api";

// A file's processing states as server-sent events (stores/upload-store.ts follows it). A stream lasts while the
// file's workflow run does; the browser reconnects with Last-Event-ID if the function's time runs out first.
export const GET = async (req: Request, { params }: { params: Promise<{ id: string }> }) => fileEventsRoute(req, (await params).id);

export const maxDuration = 300;
