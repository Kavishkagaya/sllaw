import { docWithChunks } from "@sllaw/etl_db";

export const getDoc = (key: string) => docWithChunks(key);
