import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({
      // The marketing surface is fully static, so it is prerendered at build
      // time rather than server-rendered per request. This is what recovers the
      // SEO/TTFB argument we would otherwise have lost by not choosing Astro
      // (ADR 0001).
      prerender: {
        enabled: true,
        crawlLinks: false,
      },
      // Only the landing page is fully static. The directory is server-rendered
      // per request because its content changes minute to minute, and rooms are
      // authenticated.
      pages: [{ path: '/' }],
    }),
    viteReact(),
  ],

  // `src/lib/api.ts` and `src/realtime/socket.ts` read
  // `import.meta.env.PUBLIC_*`, which Vite only populates for names matching
  // envPrefix — `VITE_` by default. Without `PUBLIC_` here the Docker build args
  // are silently dropped, both reads fall back to the current origin, and the
  // deployed client sends its API and WebSocket traffic to the web host instead
  // of the API host.
  envPrefix: ['VITE_', 'PUBLIC_'],

  // Prerendering boots a preview server on an ephemeral port and fetches the
  // pages over the loopback interface. Left to default, Vite binds the literal
  // name `localhost`, and inside a Docker build that resolves to ::1 first —
  // where nothing answers, because the daemon gives containers no working IPv6
  // loopback. The build then dies on `fetch failed / UND_ERR_CONNECT_TIMEOUT`
  // after burning the 10s connect timeout. Pinning the address takes name
  // resolution out of the loop entirely.
  preview: {
    host: '127.0.0.1',
  },

  server: {
    port: 3000,
    proxy: {
      // Same-origin in development, so cookies behave exactly as they do in
      // production behind the reverse proxy. Cross-origin dev setups hide
      // SameSite bugs until deploy.
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },

  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // The YouTube player and WebRTC machinery are only needed inside a
          // room; keeping them out of the landing bundle is most of the
          // Lighthouse budget.
          if (id.includes('node_modules')) {
            if (id.includes('motion')) return 'motion';
            if (id.includes('@tanstack')) return 'tanstack';
            if (id.includes('@radix-ui')) return 'radix';
          }
          return undefined;
        },
      },
    },
  },
});
