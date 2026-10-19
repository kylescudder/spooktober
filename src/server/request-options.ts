import "@tanstack/react-start/server-only";
import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { clerkConfiguration, configuration, privateHeaders } from "./auth";
import { healthResponse } from "./health";

const privateRequests = createMiddleware().server(async ({ request, next }) => {
  // Set these before Clerk so its handshake redirects also remain private.
  for (const [name, value] of Object.entries(privateHeaders)) setResponseHeader(name, value);
  const path = new URL(request.url).pathname;
  // Readiness must stay independent of Clerk and contain no watchlist data.
  if (path === "/healthz" && ["GET", "HEAD"].includes(request.method)) return healthResponse();
  if (path.startsWith("/api/") && !clerkConfiguration().configured) {
    return Response.json({ error: "Sign-in is still being set up. Please try again later." }, { status: 503, headers: privateHeaders });
  }
  return next();
});

const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

export function requestOptions() {
  const clerk = clerkConfiguration();
  const { publicURL } = configuration();
  return {
    requestMiddleware: [privateRequests, csrf, ...(clerk.configured ? [clerkMiddleware({
      publishableKey: clerk.publishableKey,
      signInUrl: "/sign-in", signUpUrl: "/sign-in",
      authorizedParties: publicURL ? [publicURL] : ["http://localhost:8080", "http://127.0.0.1:8080"],
    })] : [])],
  };
}
