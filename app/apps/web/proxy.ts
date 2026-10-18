import { clerkMiddleware } from "@clerk/nextjs/server";

// Clerk's session on every request; routes are public here, procedures check auth (api: signedUser).
export default clerkMiddleware();

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"],
};
