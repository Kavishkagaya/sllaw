// Whether a step that threw is worth another try. Packages say what their errors are (an HTTP `status`, the AI
// SDK's `isRetryable`, our `retryable`, extract's Unreadable); this is the one place that decides.
//   retried: network errors, timeouts, 408, 425, 429, 5xx, and anything unknown
//   not retried: a file its parser cannot read, other 4xx (a bad request or key: the same request fails again)
import { Unreadable } from "@sllaw/extract";

export function isRetryable(e: unknown): boolean {
  if (e instanceof Unreadable) return false;
  const x = (e ?? {}) as { retryable?: unknown; isRetryable?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof x.retryable === "boolean") return x.retryable;
  if (typeof x.isRetryable === "boolean") return x.isRetryable;
  const status = typeof x.status === "number" ? x.status : typeof x.statusCode === "number" ? x.statusCode : null;
  if (status != null) return status === 408 || status === 425 || status === 429 || status >= 500;
  return true;
}
