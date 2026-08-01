import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { NotFound } from '~/components/not-found';
import { Providers } from '~/components/providers';
import { themeBootstrapScript } from '~/components/theme-provider';
import appCss from '~/styles/app.css?url';

/**
 * The application shell.
 *
 * Everything that must survive navigation lives here: the query cache, the
 * theme and the toaster. This is the concrete reason for a framework with real
 * layout routes — the room shell is not torn down and rebuilt when the URL
 * changes underneath it.
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { title: 'playercn — watch anything together, perfectly in sync' },
      {
        name: 'description',
        content:
          'Create a room, share one link, and watch together in perfect sync — YouTube, direct video files, HLS and DASH streams, and whole playlists.',
      },
      { name: 'application-name', content: 'playercn' },
      { property: 'og:title', content: 'playercn' },
      { property: 'og:description', content: 'Watch anything together, perfectly in sync.' },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      // The first third-party bytes a YouTube room needs; warming these
      // removes a round trip from the critical path.
      { rel: 'preconnect', href: 'https://www.youtube.com' },
      { rel: 'preconnect', href: 'https://i.ytimg.com' },
    ],
  }),
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return (
    // `suppressHydrationWarning` is load-bearing: the bootstrap script below
    // mutates <html> before React hydrates, so the class and data-theme
    // attributes legitimately differ from the server's markup.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Applies the stored theme before first paint. Without it every page
            load flashes the default palette before settling. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: the theme bootstrap must run before paint
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
        />
      </head>
      <body className="min-h-dvh font-sans antialiased">
        <Providers>
          <Outlet />
        </Providers>
        <Scripts />
      </body>
    </html>
  );
}
