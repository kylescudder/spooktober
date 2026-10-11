// Spooktober deploy webhook receiver. Internet-facing via Cloudflare Tunnel and
// Caddy, so it has no Docker access: it verifies a signed request and drops it
// into a spool directory. A systemd path unit on the host picks it up and runs
// deploy/herman-deploy.sh, which verifies the image attestation itself.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const secret = readFileSync(process.env.WEBHOOK_SECRET_FILE || "/run/secrets/deploy_webhook_secret", "utf8").trim();
if (secret.length < 32) throw new Error("Webhook secret must be at least 32 characters.");
const spool = process.env.SPOOL_DIR || "/spool";
const port = Number(process.env.PORT || 9000);
const maxBody = 1024;
const maxSkewSeconds = 300;

const log = (message) => console.log(`[deploy-hook] ${new Date().toISOString()} ${message}`);
const reply = (response, status, message) => {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`${message}\n`);
};

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

createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") return reply(response, 200, "ok");
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
    // Write then rename so the host never sees a partial request.
    const name = `${deploy.timestamp}-${deploy.revision}.json`;
    writeFileSync(join(spool, "tmp", name), JSON.stringify(deploy), { mode: 0o600 });
    renameSync(join(spool, "tmp", name), join(spool, "requests", name));
    log(`queued ${deploy.digest} (${deploy.revision})`);
    reply(response, 202, "queued");
  });
}).listen(port, "0.0.0.0", () => log(`listening on ${port}`));
