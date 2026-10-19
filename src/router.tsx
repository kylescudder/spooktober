import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // Recheck private data and sessions on every navigation.
    defaultStaleTime: 0,
    defaultPreload: false,
  });
}

declare module "@tanstack/react-router" {
  interface Register { router: ReturnType<typeof getRouter> }
}
