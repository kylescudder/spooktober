import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { seasonSchema } from "./years";

export const loadWatchlistPage = createServerFn({ method: "GET" })
  .validator(seasonSchema.partial())
  .handler(async ({ data }) => {
    const { pageData } = await import("../server/pages");
    return pageData("watchlist", data.year);
  });

export const loadClerkConfiguration = createServerFn({ method: "GET" }).handler(async () => {
  const { clerkConfiguration } = await import("../server/auth");
  return clerkConfiguration();
});

export const loadPage = createServerFn({ method: "GET" })
  .validator(z.enum(["watchlist", "sign-in", "access-denied"]))
  .handler(async ({ data }) => {
    const { pageData } = await import("../server/pages");
    return pageData(data);
  });
