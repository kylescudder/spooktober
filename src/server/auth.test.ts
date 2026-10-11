import test from "node:test";
import assert from "node:assert/strict";
import { accessFailure, clerkConfiguration, configuration, guardMutationRequest } from "./auth.ts";
import { appRouter } from "./trpc.ts";

const config = configuration({ CLERK_ALLOWED_USER_IDS: "user_Kyle, user_Rhiann", PUBLIC_URL: "https://films.example.com" });

test("only the two configured Clerk user IDs can access the private list", () => {
  assert.equal(accessFailure("user_Kyle", config), null);
  assert.equal(accessFailure("user_Rhiann", config), null);
  assert.equal(accessFailure(null, config)?.status, 401);
  assert.equal(accessFailure("user_SomeoneElse", config)?.status, 403);
  assert.equal(accessFailure("user_kyle", config)?.status, 403);
  assert.deepEqual(configuration({ CLERK_ALLOWED_USER_IDS: "user_Kyle" }).allowedUserIDs, ["user_Kyle"]);
});

test("missing or malformed access configuration fails closed", () => {
  for (const ids of [undefined, "", "user_Kyle,", "*", "user_Kyle,user_Kyle", "user_Kyle,user_Rhiann,user_Third", "kyle@example.com"]) {
    const invalid = configuration({ CLERK_ALLOWED_USER_IDS: ids });
    assert.equal(invalid.allowedUserIDs, null);
    assert.equal(accessFailure("user_Kyle", invalid)?.status, 503);
  }
  assert.throws(() => configuration({ PUBLIC_URL: "https://films.example.com/path" }));
  assert.throws(() => configuration({ PUBLIC_URL: "https://user:password@films.example.com" }));
  assert.equal(clerkConfiguration({}).configured, false);
  assert.equal(clerkConfiguration({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "replace-with-publishable-key" }).configured, false);
});

test("every tRPC procedure independently rejects signed-out and uninvited sessions before storage", async (t) => {
  const previous = process.env.CLERK_ALLOWED_USER_IDS;
  process.env.CLERK_ALLOWED_USER_IDS = "user_Kyle,user_Rhiann";
  t.after(() => { if (previous === undefined) delete process.env.CLERK_ALLOWED_USER_IDS; else process.env.CLERK_ALLOWED_USER_IDS = previous; });
  for (const userId of [null, "user_SomeoneElse"]) {
    const caller = appRouter.createCaller({ userId });
    const code = userId ? "FORBIDDEN" : "UNAUTHORIZED";
    for (const call of [
      () => caller.films.list(),
      () => caller.films.add({ id: "00000000-0000-4000-8000-000000000001", title: "The Thing" }),
      () => caller.films.setWatched({ id: "film-01", watched: true }),
      () => caller.films.reorder({ ids: ["film-01"] }),
    ]) await assert.rejects(call, { code });
  }
  delete process.env.CLERK_ALLOWED_USER_IDS;
  await assert.rejects(appRouter.createCaller({ userId: "user_Kyle" }).films.list(), { code: "SERVICE_UNAVAILABLE" });
});

test("writes require the configured public HTTPS origin, JSON and a custom request header", () => {
  const request = (extra: Record<string, string> = {}) => new Request("http://spooktober:8080/api/trpc/films.add", { method: "POST", headers: { "content-type": "application/json", "x-spooktober-request": "1", origin: "https://films.example.com", ...extra }, body: "{}" });
  assert.equal(guardMutationRequest(request(), config), null);
  assert.equal(guardMutationRequest(request({ origin: "https://elsewhere.example" }), config)?.status, 403);
  assert.equal(guardMutationRequest(request({ "sec-fetch-site": "cross-site" }), config)?.status, 403);
  assert.equal(guardMutationRequest(request({ "x-spooktober-request": "" }), config)?.status, 403);
  assert.equal(guardMutationRequest(request({ "content-type": "text/plain" }), config)?.status, 415);
  assert.equal(guardMutationRequest(new Request("https://films.example.com/api/trpc/films.list"), config), null);
});
