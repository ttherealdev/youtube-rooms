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
      position="top-left"
      closeButton
      gap={10}
      offset={16}
      visibleToasts={4}
      // Sonner ships its own palette as inline custom properties, which beat
      // any class we could add. Restating them here is what actually makes a
      // toast follow the room's theme rather than sitting outside it in
      // Sonner's default grey.
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--success-bg': 'var(--popover)',
          '--success-text': 'var(--popover-foreground)',
          '--success-border': 'var(--border)',
          '--error-bg': 'var(--popover)',
          '--error-text': 'var(--destructive)',
          '--error-border': 'color-mix(in oklch, var(--destructive), transparent 70%)',
          '--border-radius': 'var(--radius-lg)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            'group/toast w-full items-start gap-3 border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur-md',
          title: 'text-sm font-medium leading-snug',
          description: 'text-xs leading-relaxed text-muted-foreground',
          icon: 'mt-0.5 shrink-0',
          actionButton: 'h-7 rounded-md bg-primary px-2.5 text-xs text-primary-foreground',
          cancelButton: 'h-7 rounded-md bg-muted px-2.5 text-xs text-muted-foreground',
          // Sonner reveals the close button on hover of the toast, which is a
          // coin flip on touch. Always visible, just quiet.
          closeButton:
            'left-auto right-2 top-2 size-5 rounded-md border-border bg-transparent text-muted-foreground opacity-70 transition hover:bg-muted hover:opacity-100',
          error: 'border-destructive/30',
          success: 'border-border',
        },
      }}
    />
  );
}
