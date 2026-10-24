import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { randomUUID } from "node:crypto";
import { createDatabase, migrateDatabase } from "../../../src/server/database.ts";
import { createTrpcHandler } from "../../../src/server/trpc-handler.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../../../public", import.meta.url)),
  resolve: { alias: {
    "@": fileURLToPath(new URL("../../../src", import.meta.url)),
    "@clerk/tanstack-react-start": fileURLToPath(new URL("./clerk.tsx", import.meta.url)),
  } },
  plugins: [{
    name: "watchlist-test-loader",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "../lib/page-data" && importer?.endsWith("/src/routes/index.tsx")) {
        return fileURLToPath(new URL("./page-data.ts", import.meta.url));
      }
    },
    async configureServer(server) {
      const connection = process.env.E2E_WATCHLIST_DATABASE_URL;
      if (!connection) return;
      if (!new URL(connection).pathname.endsWith("_test")) throw new Error("Use a disposable control database ending in _test.");
      const control = createDatabase(connection);
      const name = `spooktober_browser_${randomUUID().replaceAll("-", "")}`;
      await control.query(`CREATE DATABASE "${name}"`);
      const url = new URL(connection); url.pathname = `/${name}`;
      process.env.DATABASE_URL = url.href;
      process.env.CLERK_ALLOWED_USER_IDS = "user_Kyle,user_Rhiann";
      process.env.PUBLIC_URL = "";
      const pool = createDatabase(url.href);
      await migrateDatabase(pool);
      await pool.end();
      // The existing trusted-session seam replaces Clerk only in this test
      // server. Requests use the real tRPC router, validation and PostgreSQL.
      const handler = createTrpcHandler(async () => "user_Kyle");
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/trpc/")) return next();
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const response = await handler(new Request(`http://${req.headers.host}${req.url}`, {
            method: req.method, headers: req.headers as Record<string, string>,
            ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
          }));
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) { next(error as Error); }
      });
      server.httpServer?.once("close", async () => {
        const globals = globalThis as typeof globalThis & { spooktoberDatabase?: { end: () => Promise<void> } };
        await globals.spooktoberDatabase?.end();
        delete globals.spooktoberDatabase;
        await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        await control.end();
      });
    },
  }, tailwindcss(), react()],
  server: { host: "127.0.0.1", port: Number(process.env.E2E_PORT || 8080) + 3, strictPort: true, fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] } },
});
