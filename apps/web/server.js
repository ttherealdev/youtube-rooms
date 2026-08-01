// Production entry point.
//
// Run with: node server.js   (from the directory containing dist/)
import { serve } from 'srvx';
import { serveStatic } from 'srvx/static';

import handler from './dist/server/server.js';

const clientDir = new URL('./dist/client/', import.meta.url);

// Hashed filenames are content-addressed, so they can be cached forever. Any
// other static file (favicon.svg, robots.txt) gets a short TTL instead, because
// its URL stays the same when the contents change.
const IMMUTABLE = /\/assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

const staticFiles = serveStatic({ dir: clientDir.pathname });

/**
 * Static assets are served ahead of the SSR handler, but only for requests that
 * look like files. Extensionless paths fall straight through to the router:
 * the build also prerenders a shell for some of them, and serving that shell
 * would hand every visitor a cached page where an authenticated,
 * server-rendered one was intended.
 */
const assets = async (request, next) => {
  const { pathname } = new URL(request.url);
  if (pathname !== '/' && !/\.[a-z0-9]+$/i.test(pathname)) return next();

  const response = await staticFiles(request, next);
  if (response?.status === 200 && IMMUTABLE.test(pathname)) {
    response.headers.set('cache-control', 'public, max-age=31536000, immutable');
  }
  return response;
};

const server = serve({
  fetch: handler.fetch,
  middleware: [assets],
  port: Number(process.env.PORT ?? 3000),
  // Containers publish on all interfaces; the proxy in front is what limits
  // who can reach us.
  hostname: process.env.HOST ?? '0.0.0.0',
});

// srvx logs the listening address itself; awaiting `ready` is what turns a
// failure to bind into a non-zero exit instead of a container that looks up.
await server.ready();

// tini forwards SIGTERM here; close the listener so in-flight SSR responses
// finish instead of being cut off mid-stream on deploy.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close().then(() => process.exit(0));
  });
}
