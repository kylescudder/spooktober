import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { accessFailure, clerkConfiguration, configuration, privateHeaders } from "./server/auth";

function privateResponse(response: Response) {
  for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
  return response;
}

const withClerk = clerkMiddleware(async (auth, request) => {
  const path = request.nextUrl.pathname;
  if (path === "/access-denied" || path === "/sign-in" || path.startsWith("/sign-in/")) return privateResponse(NextResponse.next());
  const { userId, redirectToSignIn } = await auth({ acceptsToken: "session_token" });
  const config = configuration();
  const failure = accessFailure(userId, config);
  if (failure && path.startsWith("/api/")) return Response.json({ error: failure.error }, { status: failure.status, headers: privateHeaders });
  if (failure?.status === 401) return redirectToSignIn({ returnBackUrl: `${config.publicURL || request.nextUrl.origin}/` });
  if (failure?.status === 403) return privateResponse(NextResponse.redirect(new URL("/access-denied", config.publicURL || request.nextUrl.origin)));
  return privateResponse(NextResponse.next());
}, () => {
  const { publicURL } = configuration();
  return {
    publishableKey: clerkConfiguration().publishableKey,
    signInUrl: "/sign-in", signUpUrl: "/sign-in",
    authorizedParties: publicURL ? [publicURL] : ["http://localhost:8080", "http://127.0.0.1:8080"],
    frontendApiProxy: { enabled: false },
  };
});

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  // Missing keys never activate Clerk's development keyless provisioning and
  // never open the watchlist. The page shows a setup message; APIs fail closed.
  if (!clerkConfiguration().configured) {
    if (request.nextUrl.pathname.startsWith("/api/")) return Response.json({ error: "Sign-in is still being set up. Please try again later." }, { status: 503, headers: privateHeaders });
    return privateResponse(NextResponse.next());
  }
  const response = await withClerk(request, event);
  // Clerk attaches verified auth headers with a same-page rewrite. Next's proxy
  // and internal server can use different origins, making that rewrite loop.
  // Continue to the page while retaining Clerk's request-header overrides.
  if (response?.headers.get("x-middleware-rewrite") === request.url) {
    response.headers.delete("x-middleware-rewrite");
    response.headers.set("x-middleware-next", "1");
  }
  // Include Clerk-generated handshake/sign-in redirects in the no-store policy.
  return privateResponse(response || NextResponse.next());
}

// Only public artwork, Next.js static files and the data-free readiness probe
// bypass identity middleware. Pages and every API route run through Clerk.
export const config = { matcher: "/((?!_next/static/|_next/image|favicon\\.svg$|images/|healthz$).*)" };
