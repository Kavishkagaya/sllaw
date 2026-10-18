import { OrganizationSwitcher, Show, SignInButton, UserButton } from "@clerk/nextjs";
import { createCaller, createContext } from "@sllaw/api";
import { headers } from "next/headers";

// ponytail: account check only (Clerk → webhook → our ids); replaced by the chat page.
export default async function Home() {
  return (
    <main>
      <Show when="signed-out">
        <SignInButton />
      </Show>
      <Show when="signed-in">
        <UserButton /> <OrganizationSwitcher />
        <Me />
      </Show>
    </main>
  );
}

async function Me() {
  const me = await createCaller(await createContext({ headers: await headers() })).user.me().catch((e: Error) => e);
  if (me instanceof Error) return <p>{me.message}</p>;
  return <pre>{JSON.stringify(me, null, 2)}</pre>;
}
