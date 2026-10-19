// Spooktober deploy webhook receiver. Internet-facing via Cloudflare Tunnel and
// Caddy, so it has no Docker access: it verifies a signed request and drops it
// into a spool directory. An event-driven host service picks it up and runs
// deploy/herman-deploy.sh, which verifies the image attestation itself. A signed
// GET reports that release's sanitized status back from a read-only status directory.
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const secret = readFileSync(process.env.WEBHOOK_SECRET_FILE || "/run/secrets/deploy_webhook_secret", "utf8").trim();
if (secret.length < 32) throw new Error("Webhook secret must be at least 32 characters.");
const spool = process.env.SPOOL_DIR || "/spool";
const statusDirectory = process.env.STATUS_DIR || join(spool, "status");
const port = Number(process.env.PORT || 9000);
const maxBody = 1024;
const maxSkewSeconds = 300;

const log = (message) => console.log(`[deploy-hook] ${new Date().toISOString()} ${message}`);
const reply = (response, status, message) => {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Spooktober-Deploy-Hook": "1" });
  response.end(`${message}\n`);
};

const statuses = new Set(["running", "succeeded", "failed", "superseded"]);
const phases = new Set(["accepted", "queued", "verify", "backup", "migrate", "grant", "start", "health", "complete"]);
const rollbacks = new Set(["restored", "failed", "stopped"]);

function validSignature(body, header) {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const received = Buffer.from(String(header || ""));
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function parseRequest(body) {
  const request = JSON.parse(body.toString("utf8"));
  const { digest, revision, timestamp } = request ?? {};
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("invalid digest");
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("invalid revision");
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > maxSkewSeconds) throw new Error("stale or invalid timestamp");
  return { digest, revision, timestamp };
}

// Only these fields leave the host: no logs, errors, paths or credentials.
function releaseStatus(digest, revision) {
  const pending = { digest, revision, status: "pending" };
  try {
    const file = join(statusDirectory, `${revision}-${digest.slice("sha256:".length)}.json`);
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 1024) return pending;
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value.digest !== digest || value.revision !== revision || !statuses.has(value.status) || !phases.has(value.phase)) return pending;
    const result = { digest, revision, status: value.status, phase: value.phase };
    if (rollbacks.has(value.rollback)) result.rollback = value.rollback;
    if (Number.isSafeInteger(value.requested) && value.requested > 0) result.requested = value.requested;
    if (typeof value.updated_at === "string" && /^[0-9TZ:.+-]{10,40}$/.test(value.updated_at)) result.updated_at = value.updated_at;
    return result;
  } catch { return pending; }
}

function statusRequest(request, response) {
  const query = new URL(request.url, "http://receiver").searchParams;
  const digest = query.get("digest"), revision = query.get("revision"), timestamp = query.get("timestamp");
  const names = [...query.keys()].sort().join(",");
  if (names !== "digest,revision,timestamp" || !/^sha256:[0-9a-f]{64}$/.test(digest) || !/^[0-9a-f]{40}$/.test(revision) || !/^[0-9]{1,12}$/.test(timestamp)) return reply(response, 400, "invalid status query");
  if (!validSignature(`status\n${digest}\n${revision}\n${timestamp}`, request.headers["x-spooktober-signature"])) {
    log("rejected status request with invalid signature");
    return reply(response, 401, "invalid signature");
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > maxSkewSeconds) return reply(response, 400, "stale or invalid timestamp");
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Spooktober-Deploy-Hook": "1" });
  response.end(`${JSON.stringify(releaseStatus(digest, revision))}\n`);
}

createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") return reply(response, 200, "ok");
  if (request.method === "GET" && request.url?.startsWith("/hooks/spooktober?")) return statusRequest(request, response);
  if (request.method !== "POST" || request.url !== "/hooks/spooktober") return reply(response, 404, "not found");
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBody) { reply(response, 413, "too large"); request.destroy(); }
    else chunks.push(chunk);
  });
  request.on("end", () => {
    if (response.writableEnded) return;
    const body = Buffer.concat(chunks);
    if (!validSignature(body, request.headers["x-spooktober-signature"])) {
      log("rejected request with invalid signature");
      return reply(response, 401, "invalid signature");
    }
    let deploy;
    try { deploy = parseRequest(body); } catch (error) {
      log(`rejected signed request: ${error.message}`);
      return reply(response, 400, error.message);
    }
    // Keep both paths on the same bind mount: rename across separate mounts
    // fails with EXDEV even when the host directories share a filesystem.
    const requests = join(spool, "requests");
    if (readdirSync(requests).length >= 64) return reply(response, 503, "queue full");
    const name = `${deploy.timestamp}-${deploy.revision}-${randomUUID()}.json`;
    const temporary = join(requests, `.${name}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(deploy), { mode: 0o600, flag: "wx" });
      renameSync(temporary, join(requests, name));
    } catch {
      try { unlinkSync(temporary); } catch {}
      log("could not persist request");
      return reply(response, 503, "queue unavailable");
    }
    log(`queued ${deploy.digest} (${deploy.revision})`);
    reply(response, 202, "queued");
  });
}).listen(port, "0.0.0.0", () => log(`listening on ${port}`));
