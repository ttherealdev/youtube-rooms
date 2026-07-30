//! Realtime: the WebSocket protocol, room runtime, cross-node fan-out.
//!
//! See `docs/adr/0004-realtime-transport.md` and
//! `docs/adr/0010-horizontal-scaling.md`.

pub mod autoadvance;
pub mod hub;
pub mod protocol;
pub mod relay;
pub mod room;
pub mod session;
pub mod ws;
