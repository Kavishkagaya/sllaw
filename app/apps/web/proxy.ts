import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Every page needs a session except sign-in, sign-up, the Clerk webhook and the workflow runtime's routes (called by
// Vercel's queue, which signs its own requests); procedures still check auth (api: signedUser).
const isPublic = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/api/webhooks(.*)", "/.well-known/workflow(.*)"]);

// signInUrl here too: the proxy never sees ClerkProvider's props and would send a signed-out visitor to Clerk's hosted page
export default clerkMiddleware(
  async (auth, req) => {
    if (!isPublic(req)) await auth.protect();
  },
  { signInUrl: "/sign-in", signUpUrl: "/sign-up" },
);

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"],
};
