"use client";
// Chats live here, not in a page: one AI SDK Chat per chat id, drafts, and send. A page only shows a chat
// (useChat({ chat })), and useChat leaves an external Chat running when the page unmounts, so an answer keeps
// streaming while the user is elsewhere in the app. The server finishes and stores it even if the tab closes.
import { Chat } from "@ai-sdk/react";
import type { ChatMessage } from "@sllaw/api";
import { DefaultChatTransport } from "ai";
import { create } from "zustand";

// the Chat objects themselves: not reactive state (a page subscribes to its Chat through useChat), so opening one
// during render updates nothing
const chats = new Map<string, Chat<ChatMessage>>();

type State = {
  drafts: Record<string, string>; // per chat id; "new" for the home page
  busy: Record<string, boolean>; // chats with an answer in flight
  unread: Record<string, boolean>; // answers that finished while their chat was not on screen
  viewing: string | null; // the chat on screen
  view: (id: string | null) => void;
  listVersion: number; // bumped when the server's chat list changed (a chat created, an answer stored)
  /** The chat for this id: the live one if any, else one starting from the stored messages. */
  open: (id: string, initial?: ChatMessage[]) => Chat<ChatMessage>;
  setDraft: (key: string, text: string) => void;
  send: (id: string, text: string) => void;
  /** The stop button: aborts the request, and the server aborts the agent with it (the answer so far is kept). */
  stop: (id: string) => void;
};

export const useChatStore = create<State>()((set, get) => {
  const done = (id: string) =>
    set((s) => ({
      busy: { ...s.busy, [id]: false },
      unread: { ...s.unread, [id]: s.viewing !== id },
      listVersion: s.listVersion + 1,
    }));
  const make = (id: string, messages: ChatMessage[]) =>
    new Chat<ChatMessage>({
      id,
      messages,
      transport: new DefaultChatTransport({
        api: "/api/chat",
        // only the new message goes up: the server holds the history
        prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, message: messages.at(-1) } }),
        // the response starts after the server created the chat row: the sidebar can list it now
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          set((s) => ({ listVersion: s.listVersion + 1 }));
          return res;
        },
      }),
      onFinish: () => done(id),
      onError: () => done(id),
    });

  return {
    drafts: {},
    busy: {},
    unread: {},
    viewing: null,
    listVersion: 0,
    view: (id) => set((s) => ({ viewing: id, unread: id ? { ...s.unread, [id]: false } : s.unread })),
    open: (id, initial = []) => {
      if (typeof window === "undefined") return make(id, initial); // SSR: the module is shared by every request
      let chat = chats.get(id);
      if (!chat) chats.set(id, (chat = make(id, initial)));
      return chat;
    },
    setDraft: (key, text) => set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
    send: (id, text) => {
      if (!text.trim() || get().busy[id]) return;
      set((s) => ({ busy: { ...s.busy, [id]: true } }));
      void get().open(id).sendMessage({ text: text.trim() });
    },
    stop: (id) => {
      void chats.get(id)?.stop();
      set((s) => ({ busy: { ...s.busy, [id]: false } })); // onFinish is skipped when stopped before the response
    },
  };
});
