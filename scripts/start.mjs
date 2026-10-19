import "../src/server/load-env.mjs";

process.env.HOST ??= "127.0.0.1";
process.env.PORT ??= "8080";
await import("../.output/server/index.mjs");
