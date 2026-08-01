import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Toaster } from 'sonner';
import { SessionProvider } from '~/components/session-provider';
import { ThemeProvider, useTheme } from '~/components/theme-provider';
import { TooltipProvider } from '~/components/ui/tooltip';

/**
 * Everything that must survive navigation.
 *
 * The query client is created in state rather than at module scope: a
 * module-level client is shared across requests on the server, which would leak
 * one user's cached room data into another user's render.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Room data arrives over the socket, so REST results are background
            // context rather than live truth. Long stale times, no refetch
            // storms on window focus.
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Never retry an auth or validation failure; it fails identically.
              const status = (error as { status?: number }).status;
              if (status && status >= 400 && status < 500 && status !== 429) return false;
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ThemeProvider>
          <TooltipProvider>
            {children}
            <ThemedToaster />
          </TooltipProvider>
        </ThemeProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

/**
 * Toasts follow the active theme.
 *
 * Sonner renders in a portal outside the themed subtree, so it has to be told
 * the mode explicitly — left alone it picks a light surface inside a dark room.
 */
function ThemedToaster() {
  const { mode } = useTheme();

  return (
    <Toaster
      theme={mode}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: 'bg-popover text-popover-foreground border-border',
          description: 'text-muted-foreground',
        },
      }}
    />
  );
}
