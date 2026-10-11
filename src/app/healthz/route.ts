import { database, readyDatabase } from "../../server/database";
import { privateHeaders } from "../../server/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  try {
    await readyDatabase(database());
    return new Response("ok\n", { headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("unavailable\n", { status: 503, headers: privateHeaders });
  }
}
