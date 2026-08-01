import { createRouter } from '@tanstack/react-router';
import { NotFound } from './components/not-found';
import { routeTree } from './routeTree.gen';

/**
 * Start calls `getRouter()` once per request on the server and once on the
 * client. It must return a fresh instance per call — a shared router would leak
 * one user's loader data into another's SSR render.
 */
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    // Preloading a route the user is merely hovering should not fire a network
    // request every few hundred milliseconds.
    defaultPreloadStaleTime: 30_000,
    defaultNotFoundComponent: NotFound,
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
