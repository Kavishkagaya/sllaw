import { fileUploadRoute } from "@sllaw/api";

// The upload's bytes through the app: only for a store with no direct upload (STORAGE=memory, local runs).
export const PUT = async (req: Request, { params }: { params: Promise<{ id: string }> }) => fileUploadRoute(req, (await params).id);
