// The UI stream on its way to the client, in real ids: citations in text ([[s3]] -> [[81234|s. 22, Rent Act]]) and
// the id fields of tool inputs and outputs. A citation can arrive split over deltas ("[[s" then "3]]"), so a text's
// unclosed "[[" is held back until it closes or the text ends.
import type { UIMessageChunk } from "ai";
import type { SourceMap } from "./map";
import { SPECS } from "./specs";
import { citesToReal, idsToReal } from "./wrap";

const HOLD = 200; // an "[[" open longer than this is no citation: let it through

/** Splits a text at an unclosed citation: what can go out now, and what waits for more. */
export function holdBack(buf: string): [string, string] {
  const i = buf.lastIndexOf("[[");
  if (i >= 0 && buf.indexOf("]]", i) < 0 && buf.length - i < HOLD) return [buf.slice(0, i), buf.slice(i)];
  if (buf.endsWith("[")) return [buf.slice(0, -1), "["];
  return [buf, ""];
}

export function realStream(map: SourceMap): TransformStream<UIMessageChunk, UIMessageChunk> {
  const held = new Map<string, string>(); // text id -> held back
  const names = new Map<string, string>(); // tool call id -> tool name (an output chunk has only the call id)
  return new TransformStream({
    transform(c, out) {
      switch (c.type) {
        case "text-delta": {
          const [now, later] = holdBack((held.get(c.id) ?? "") + c.delta);
          held.set(c.id, later);
          if (now) out.enqueue({ ...c, delta: citesToReal(now, map) });
          return;
        }
        case "text-end": {
          const rest = held.get(c.id);
          held.delete(c.id);
          if (rest) out.enqueue({ type: "text-delta", id: c.id, delta: citesToReal(rest, map) });
          out.enqueue(c);
          return;
        }
        case "tool-input-start":
          names.set(c.toolCallId, c.toolName);
          out.enqueue(c);
          return;
        case "tool-input-available":
        case "tool-input-error":
          names.set(c.toolCallId, c.toolName);
          out.enqueue({ ...c, input: idsToReal(c.input, SPECS[c.toolName]?.in, map) });
          return;
        case "tool-output-available": {
          const spec = SPECS[names.get(c.toolCallId) ?? ""];
          out.enqueue(spec ? { ...c, output: idsToReal(c.output, spec.out, map) } : c);
          return;
        }
        default:
          out.enqueue(c);
      }
    },
  });
}
