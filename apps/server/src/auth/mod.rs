//! Authentication: Google OAuth, guest sessions, tokens and cookies.
//!
//! See `docs/adr/0007-authentication.md`.

pub mod cookies;
pub mod extract;
pub mod google;
pub mod password;
pub mod routes;
pub mod tokens;

pub use extract::{CurrentUser, MaybeUser};
