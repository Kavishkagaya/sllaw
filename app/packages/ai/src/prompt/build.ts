// How an agent's system prompt and tools are put together. An agent is a Setup: a list of sections and a list of
// tool groups, each with an optional `when` on the turn's input. Adding to an agent (a new kind of chat, a new data
// source, a new rule) is a new section or tool group in its setup, not an edit to one long string.
//
// Markup: a section's title is a markdown heading, one level deeper per nesting (# then ##); text that comes from
// users or their files goes in a `data` block (<tag>...</tag>), so the model can tell what it is told from what it
// reads (guard.ts). Sections render in list order: keep the ones that change per chat (the case) last, so the start
// of the prompt stays the same across chats and the provider's prompt cache holds.
import type { Tool } from "ai";

type Text<I> = string | ((input: I) => string | null | undefined);

export type Section<I> = {
  title?: string; // a heading; none: the body alone
  body?: Text<I>;
  children?: Section<I>[]; // sub-sections, one heading level down
  when?: (input: I) => boolean; // left out: always
};

/** A section: a title and its content (text, a function of the input, or sub-sections). */
export function section<I>(
  title: string | null,
  content: Text<I> | Section<I>[],
  opts: { when?: (input: I) => boolean } = {},
): Section<I> {
  return Array.isArray(content)
    ? { title: title ?? undefined, children: content, when: opts.when }
    : { title: title ?? undefined, body: content, when: opts.when };
}

/** A section that renders only when `when` holds. */
export const when = <I>(test: (input: I) => boolean, s: Section<I>): Section<I> => ({
  ...s,
  when: s.when ? (i) => test(i) && s.when!(i) : test,
});

function render<I>(s: Section<I>, input: I, level: number): string {
  if (s.when && !s.when(input)) return "";
  const body = (typeof s.body === "function" ? s.body(input) : s.body)?.trim() ?? "";
  const kids = (s.children ?? []).map((c) => render(c, input, s.title ? level + 1 : level)).filter(Boolean);
  if (!body && !kids.length) return ""; // an empty section leaves no lone heading
  const head = s.title ? `${"#".repeat(level)} ${s.title}` : "";
  return [head, body, ...kids].filter(Boolean).join("\n");
}

/** The prompt: every section whose `when` holds, in order, a blank line between them. */
export const buildPrompt = <I>(sections: Section<I>[], input: I) =>
  sections
    .map((s) => render(s, input, 1))
    .filter(Boolean)
    .join("\n\n");

// ---- tools ----

export type ToolGroup<I, T extends Record<string, Tool> = Record<string, Tool>> = {
  name: string;
  when?: (input: I) => boolean;
  tools: (input: I) => T;
};

export const toolGroup = <I, T extends Record<string, Tool>>(g: ToolGroup<I, T>) => g;

type ToolsOf<G> = G extends ToolGroup<any, infer T> ? T : never;
type Both<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer X) => void ? X : never;
/** Every tool any group can give, typed as present: a group left out by `when` adds none at run time, and a message
 *  can only hold a call to a tool the agent had. */
export type ToolsOfGroups<Gs extends readonly ToolGroup<any, any>[]> = Both<ToolsOf<Gs[number]>>;

/** The tools of every group whose `when` holds. Two groups giving the same name is a bug, not an override. */
export function buildTools<I, const Gs extends readonly ToolGroup<I, any>[]>(groups: Gs, input: I) {
  const out: Record<string, Tool> = {};
  for (const g of groups) {
    if (g.when && !g.when(input)) continue;
    for (const [name, t] of Object.entries(g.tools(input) as Record<string, Tool>)) {
      if (name in out) throw new Error(`tool ${name} is in two groups (${g.name})`);
      out[name] = t;
    }
  }
  return out as ToolsOfGroups<Gs>;
}

// ---- setups ----

/** An agent's prompt and tools. P is what its prompt is built from (the ctx and per-turn things: the id map, the
 *  step); the tool groups take the ctx. */
export type Setup<P, Gs extends readonly ToolGroup<any, any>[]> = { sections: Section<P>[]; tools: Gs };
export const setup = <P, const Gs extends readonly ToolGroup<any, any>[]>(s: Setup<P, Gs>) => s;
