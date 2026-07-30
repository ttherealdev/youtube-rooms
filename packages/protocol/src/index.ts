/**
 * The wire contract between the Rust server and the browser.
 *
 * The Rust `serde` definitions in apps/server/src/realtime/protocol.rs are
 * canonical; these schemas mirror them. `pnpm test:protocol` drives the
 * server's sample endpoint and parses every variant, so drift shows up as a
 * failing test rather than a runtime surprise (ADR 0011).
 */

export * from './client-messages.ts';
export { clientMessage as clientMessageSchema } from './client-messages.ts';
export * from './primitives.ts';
export * from './rest.ts';
export * from './server-messages.ts';
export { serverMessage as serverMessageSchema } from './server-messages.ts';
export * from './timeline.ts';
