import type { NextConfig } from 'next';

/**
 * The web app is a thin client over the Rust API: no data layer here, no
 * database, no server actions. What Next gives us over the previous Vite setup
 * is a real layout tree, so the room shell survives navigation, plus
 * server-rendered marketing pages for SEO.
 */
const config: NextConfig = {
  reactStrictMode: true,

  // Emits `.next/standalone` with a self-contained server and only the
  // dependencies it actually traced. That is what lets the runtime image skip
  // `pnpm deploy` and a full node_modules tree entirely.
  output: 'standalone',

  typedRoutes: true,

  experimental: {
    // The workspace is on TypeScript 7, whose compiler API Next cannot drive
    // directly. This makes the build shell out to `tsc` instead, which is the
    // supported path until Next's own type checker catches up.
    useTypeScriptCli: true,
  },

  transpilePackages: ['@playercn/protocol'],

  images: {
    // Room artwork comes from YouTube and from arbitrary playlist logos, so the
    // remote allowlist is deliberately broad for https. Anything narrower would
    // silently blank the thumbnail of every imported IPTV channel.
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },

  async rewrites() {
    // In development the API runs on its own port. Proxying it through Next
    // keeps the browser same-origin, so cookies behave exactly as they do in
    // production behind the reverse proxy — cross-origin dev setups hide
    // SameSite bugs until deploy.
    //
    // Note this covers HTTP only. Next's rewrites do not proxy WebSocket
    // upgrades, so the socket connects to the API origin directly via
    // NEXT_PUBLIC_WS_URL (see src/realtime/socket.ts).
    const api = process.env.API_PROXY_URL ?? 'http://localhost:8080';
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};

export default config;
