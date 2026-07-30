//! Server-authoritative playback synchronisation.

pub mod timeline;

pub use timeline::{Timeline, is_allowed_rate};
