import { build } from "esbuild";

// The maintenance commands use the app's server code, bundled for the same image.
await build({
  entryPoints: ["src/server/cli.ts"], outfile: ".next/database.cjs", bundle: true,
  platform: "node", target: "node22", format: "cjs", minify: true,
  external: ["pg-native"],
  plugins: [{ name: "server-only", setup(builder) {
    builder.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "server-only" }));
    builder.onLoad({ filter: /.*/, namespace: "server-only" }, () => ({ contents: "", loader: "js" }));
  } }],
});
