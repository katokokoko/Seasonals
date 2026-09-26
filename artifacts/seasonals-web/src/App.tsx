import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { AppShell } from "./shell/AppShell";
import { HomeLobby } from "./home/HomeLobby";

// work screen 専用 module は lazy load (UI v2 §17)
const ExploreMenu = lazy(() => import("./explore/ExploreMenu"));
const CalendarWorkspace = lazy(() => import("./calendar/CalendarWorkspace"));
const AgentWorkspace = lazy(() => import("./agent/AgentWorkspace"));
const DashboardWorkspace = lazy(() => import("./dashboard/DashboardWorkspace"));
const SettingsScreen = lazy(() => import("./settings/SettingsScreen"));

const lazyEl = (node: ReactNode) => <Suspense fallback={<div className="route-loading" aria-busy="true" />}>{node}</Suspense>;

export const routes = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <HomeLobby /> },
      { path: "menu", element: lazyEl(<ExploreMenu />) },
      // 旧 URL (Explore → Menu に改名) は redirect
      { path: "explore", element: <Navigate to="/menu" replace /> },
      { path: "calendar", element: lazyEl(<CalendarWorkspace />) },
      { path: "agent", element: lazyEl(<AgentWorkspace />) },
      { path: "dashboard", element: lazyEl(<DashboardWorkspace />) },
      { path: "settings", element: lazyEl(<SettingsScreen />) },
      { path: "*", element: lazyEl(<NotFound />) },
    ],
  },
];

function NotFound() {
  return (
    <div className="workspace-content" data-water-quiet="work">
      <p>Page not found.</p>
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, gcTime: 10 * 60_000 } },
});

const router = createBrowserRouter(routes);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
