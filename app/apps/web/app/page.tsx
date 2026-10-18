import { Show, SignInButton, OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { serverApi } from "../trpc/server";

export default function Home() {
  return (
    <main className="home">
      <Show when="signed-out">
        <h1>sllaw</h1>
        <p>Sri Lankan law, answered with citations.</p>
        <SignInButton />
      </Show>
      <Show when="signed-in">
        <header className="bar">
          <OrganizationSwitcher hidePersonal />
          <UserButton />
        </header>
        <Chats />
      </Show>
    </main>
  );
}

async function Chats() {
  const chats = await (await serverApi()).chat.list().catch((e: Error) => e);
  if (chats instanceof Error) return <p className="error">{chats.message}</p>;
  return (
    <>
      {/* the client mints a chat's id; the row exists from its first message */}
      <Link className="new" href={`/chat/${randomUUID()}`}>New chat</Link>
      <ul className="chats">
        {chats.map((c) => (
          <li key={c.id}><Link href={`/chat/${c.id}`}>{c.title}</Link></li>
        ))}
      </ul>
    </>
  );
}
