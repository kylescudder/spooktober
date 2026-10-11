import { database, readyDatabase } from "../../server/database";
import { privateHeaders } from "../../server/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  try {
    await readyDatabase(database());
    // The public source commit lets releases confirm what is running; it is not sensitive.
    const revision = process.env.SPOOKTOBER_REVISION || "unknown";
    return new Response(`ok\nrevision ${revision}\n`, { headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8", "X-Spooktober-Revision": revision } });
  } catch {
    return new Response("unavailable\n", { status: 503, headers: privateHeaders });
  }
}
