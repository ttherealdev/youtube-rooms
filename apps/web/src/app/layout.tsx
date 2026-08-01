import type { Metadata, Viewport } from 'next';
import { Providers } from '~/components/providers';
import { themeBootstrapScript } from '~/components/theme-provider';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '~/styles/app.css';

export const metadata: Metadata = {
  title: {
    default: 'playercn — watch anything together, perfectly in sync',
    template: '%s · playercn',
  },
  description:
    'Create a room, share one link, and watch together in perfect sync — YouTube, direct video files, HLS and DASH streams, and whole playlists.',
  applicationName: 'playercn',
  openGraph: {
    title: 'playercn',
    description: 'Watch anything together, perfectly in sync.',
    type: 'website',
  },
  twitter: { card: 'summary_large_image' },
  icons: { icon: '/favicon.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fcfcfc' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `suppressHydrationWarning` is required and load-bearing: the bootstrap
    // script below mutates <html> before React hydrates, so the class and
    // data-theme attributes legitimately differ from the server's markup.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint. Without it every page
            load flashes the default palette before settling. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        {/* The first third-party bytes a YouTube room needs; warming these
            removes a round trip from the critical path. */}
        <link rel="preconnect" href="https://www.youtube.com" />
        <link rel="preconnect" href="https://i.ytimg.com" />
      </head>
      <body className="min-h-dvh font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
