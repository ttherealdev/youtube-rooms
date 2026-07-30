//! Room password hashing.
//!
//! Argon2id with the RustCrypto defaults (19 MiB, t=2, p=1), which is the
//! OWASP-recommended baseline. These are room passwords shared among friends,
//! not account credentials — but they are still hashed properly, because people
//! reuse passwords everywhere and a leak of "just a room password" is a leak of
//! someone's real password.

use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| anyhow::anyhow!("failed to hash password: {e}"))
}

/// Verify a candidate against a stored hash.
///
/// Returns `false` — never an error — for a malformed stored hash, so a corrupt
/// row denies access rather than granting it or leaking a distinguishable
/// error to the caller.
pub fn verify_password(password: &str, stored_hash: &str) -> bool {
    match PasswordHash::new(stored_hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(error) => {
            tracing::error!(?error, "stored password hash is unparseable");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_correct_password() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash));
    }

    #[test]
    fn rejects_the_wrong_password() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(!verify_password("Correct Horse Battery Staple", &hash));
        assert!(!verify_password("", &hash));
    }

    #[test]
    fn salts_make_identical_passwords_hash_differently() {
        let a = hash_password("same").unwrap();
        let b = hash_password("same").unwrap();
        assert_ne!(a, b, "missing per-hash salt");
        assert!(verify_password("same", &a));
        assert!(verify_password("same", &b));
    }

    #[test]
    fn a_corrupt_stored_hash_denies_access() {
        assert!(!verify_password("anything", "not-a-phc-string"));
        assert!(!verify_password("anything", ""));
    }

    #[test]
    fn uses_argon2id() {
        let hash = hash_password("x").unwrap();
        assert!(hash.starts_with("$argon2id$"), "got {hash}");
    }
}
