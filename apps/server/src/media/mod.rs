//! Playable media: what a source is, and how a list of them is imported.
//!
//! Everything a room can play resolves through here. Keeping classification in
//! one place is what lets the queue, the timeline and the client agree on how a
//! given URL should be played without each re-sniffing it.

pub mod fetch;
pub mod playlist;
pub mod relay;
pub mod source;

pub use playlist::Parsed;
pub use source::{Classified, MediaSource, SourceKind, classify};
