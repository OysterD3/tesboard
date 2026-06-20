import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { routeTree } from './routeTree.gen'
import { PendingScreen } from './components/PendingScreen'

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // The data is refreshed server-side by the cron poller (~2 min); a 60s
        // client stale window avoids redundant refetches while keeping nav snappy.
        staleTime: 60_000,
        retry: 1,
        refetchOnWindowFocus: true,
      },
    },
  })

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    // react-query owns caching now; let the router preload trigger the query and
    // react-query's staleTime decide whether it actually refetches.
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PendingScreen,
  })

  // Wires QueryClientProvider (via router Wrap) + cache hydration. In SPA mode
  // there's no SSR payload to hydrate; route loaders call ensureQueryData, which
  // populates this same client cache before components render.
  setupRouterSsrQueryIntegration({ router, queryClient })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
