import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { Toaster } from 'sonner';
import { NotFound } from '~/components/not-found';
import appCss from '~/styles/app.css?url';

/**
 * The application shell.
 *
 * Everything that must survive navigation lives here: the query cache, the
 * theme, the toaster, and — critically — the mini-player mount point. This is
 * the concrete reason for choosing a framework with real layout routes
 * (ADR 0001).
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Room data arrives over the socket, so REST results are background
      // context rather than live truth. Long stale times, no window-focus
      // refetch storms.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry an auth or validation failure — it will fail identically.
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500 && status !== 429) return false;
        return failureCount < 2;
      },
    },
  },
});

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'YouTube Room — watch together, perfectly in sync' },
      {
        name: 'description',
        content:
          'Create a room, share the link, and watch YouTube with friends in perfect sync — with voice chat, a shared queue and live chat.',
      },
      { name: 'theme-color', content: '#0b0b12' },
      { property: 'og:title', content: 'YouTube Room' },
      { property: 'og:description', content: 'Watch YouTube together, perfectly in sync.' },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      // The player iframe and its thumbnails are the first third-party bytes
      // a room needs; warming the connections removes a round trip from the
      // critical path.
      { rel: 'preconnect', href: 'https://www.youtube.com' },
      { rel: 'preconnect', href: 'https://i.ytimg.com' },
    ],
  }),
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <AmbientBackdrop />
        <RouteTransition>
          <Outlet />
        </RouteTransition>
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            className: 'glass !rounded-[var(--radius-md)] !text-[var(--text-primary)]',
          }}
        />
      </QueryClientProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Applies the stored theme before first paint. Without this the page
            flashes the default theme on every load. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: inline theme bootstrap must run before paint
          dangerouslySetInnerHTML={{
            __html: `(()=>{try{const t=localStorage.getItem('yr-theme');if(t)document.documentElement.dataset.theme=t;}catch{}})()`,
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Two slow-drifting colour fields behind everything.
 *
 * Pure CSS on the compositor, no JS per frame, and removed outright under
 * `prefers-reduced-motion`.
 */
function AmbientBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
      <div
        className="animate-ambient absolute -top-1/3 left-1/2 size-[42rem] -translate-x-1/2 rounded-full blur-3xl"
        style={{ background: 'var(--ambient-a)' }}
      />
      <div
        className="animate-ambient absolute -bottom-1/4 -right-1/4 size-[36rem] rounded-full blur-3xl"
        style={{ background: 'var(--ambient-b)', animationDelay: '-9s' }}
      />
      {/* Faint grid, for depth without texture files */}
      <div
        className="absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage:
            'linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse at 50% 0%, black, transparent 75%)',
        }}
      />
    </div>
  );
}

/**
 * Cross-fade between routes.
 *
 * Opacity only, no transform: a sliding page under a fixed player is nauseating
 * and the movement communicates nothing.
 */
function RouteTransition({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pathname}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
