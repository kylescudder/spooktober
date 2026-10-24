"use client";

import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import type { inferRouterInputs } from "@trpc/server";
import type { AppRouter } from "../server/trpc";

type Inputs = inferRouterInputs<AppRouter>["films"];
export type SaveAction =
  | { procedure: "add"; input: Omit<Inputs["add"], "year"> }
  | { procedure: "setWatched"; input: Omit<Inputs["setWatched"], "year"> }
  | { procedure: "reorder"; input: Omit<Inputs["reorder"], "year"> };

const client = createTRPCClient<AppRouter>({ links: [httpBatchLink({
  url: "/api/trpc", headers: { "X-Spooktober-Request": "1" },
  fetch(url, options) { return fetch(url, { ...options, credentials: "same-origin", cache: "no-store" }); },
})] });

export async function sendRequest(year: number, action?: SaveAction) {
  try {
    if (!action) return await client.films.list.query({ year });
    switch (action.procedure) {
      case "add": return await client.films.add.mutate({ ...action.input, year });
      case "setWatched": return await client.films.setWatched.mutate({ ...action.input, year });
      case "reorder": return await client.films.reorder.mutate({ ...action.input, year });
    }
  } catch (error) {
    if (error instanceof TRPCClientError) {
      if ((error.meta?.response instanceof Response && error.meta.response.status === 401) || error.data?.code === "UNAUTHORIZED") throw new Error("Please reload the page to sign in again.");
      if ((error.meta?.response instanceof Response && error.meta.response.status === 403) || error.data?.code === "FORBIDDEN") throw new Error("This watchlist is private to Kyle and Rhiann.");
      if (error.data) throw new Error(error.message);
    }
    throw new Error("The watchlist is temporarily unavailable. Please try again.");
  }
}
