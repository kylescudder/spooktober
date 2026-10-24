import React from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { Route } from "../../../src/routes/index";
import "../../../src/styles.css";

// Exercise the production route, picker, URL navigation and film component.
// Only the server loader and Clerk account widget are replaced in this fixture.
const root = createRootRoute({ component: Outlet });
const index = Route.update({ id: "/", path: "/", getParentRoute: () => root } as any);
const router = createRouter({ routeTree: root.addChildren([index]), defaultPreload: false });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
