import { auth } from "@clerk/nextjs/server";
import { clerkConfiguration, privateHeaders } from "../../../../server/auth";
import { createTrpcHandler } from "../../../../server/trpc-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handler = createTrpcHandler(async () => (await auth({ acceptsToken: "session_token" })).userId);

async function route(request: Request) {
  if (!clerkConfiguration().configured) return Response.json({ error: "Sign-in is still being set up. Please try again later." }, { status: 503, headers: privateHeaders });
  return handler(request);
}
export const GET = route;
export const POST = route;
