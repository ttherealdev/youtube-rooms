import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Prerendering is what used to make the Docker build take five minutes: the
// step spins up a preview server, crawls it, and then the build process sits
// on the open handle until something times it out. The landing page is cheap
// to server-render, so it is only worth paying that cost when a build
// explicitly asks for it.
const prerender = process.env.PRERENDER === '1';

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({
      prerender: {
        enabled: prerender,
        crawlLinks: false,
      },
      pages: prerender ? [{ path: '/' }] : [],
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
  // loopback.
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
    // Source maps for the client bundle cost more build time than everything
    // else in this config combined, and shipping 3 MB of them to production
    // serves nobody. `SOURCEMAP=1` turns them back on for a debugging build.
    sourcemap: process.env.SOURCEMAP === '1',
    // Every dependency below is loaded lazily inside a room, so the warning
    // was firing on chunks that a landing-page visitor never downloads.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // Playback libraries are only pulled in by the engine that needs
          // them, so keeping them separate is what makes a YouTube room avoid
          // downloading the HLS and DASH stacks entirely.
          if (id.includes('hls.js')) return 'hls';
          if (id.includes('dashjs')) return 'dash';
          if (id.includes('motion')) return 'motion';
          if (id.includes('@tanstack')) return 'tanstack';
          if (id.includes('@base-ui')) return 'base-ui';
          return undefined;
        },
      },
    },
  },
});
