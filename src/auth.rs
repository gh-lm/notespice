//! Authentication.
//!
//! Single user, by design - this is a personal notes app, not a
//! multi-tenant product. Security still matters just as much for a
//! single-user app (arguably more, since there's no admin watching for
//! abuse), so:
//!
//! - The password is never stored or compared in plaintext. It's hashed
//!   with Argon2id (the current recommended password hash) at startup
//!   and only the hash lives in memory.
//! - Sessions are opaque random tokens, held server-side in memory and
//!   handed to the browser as an HttpOnly, Secure, SameSite=Strict
//!   cookie. The cookie value itself carries no information an attacker
//!   could use even if intercepted in a way that skipped TLS - it's just
//!   a lookup key, not a signed blob of claims.
//! - Login attempts are rate-limited per source IP to blunt brute force.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::rngs::OsRng;
use rand::RngCore;
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

pub const SESSION_COOKIE_NAME: &str = "notespice_session";
const SESSION_LIFETIME: Duration = Duration::from_secs(60 * 60 * 24 * 14); // 14 days
const MAX_LOGIN_ATTEMPTS: u32 = 8;
const LOGIN_ATTEMPT_WINDOW: Duration = Duration::from_secs(15 * 60);

pub struct Auth {
    username: String,
    password_hash: String,
    sessions: RwLock<HashMap<String, Instant>>,
    login_attempts: RwLock<HashMap<String, (u32, Instant)>>,
}

impl Auth {
    /// Hashes the configured plaintext password once at startup. The
    /// plaintext is dropped immediately after; only the Argon2 hash is
    /// ever kept in memory.
    pub fn new(username: String, plaintext_password: &str) -> anyhow::Result<Self> {
        let salt = SaltString::generate(&mut OsRng);
        let argon2 = Argon2::default();
        let password_hash = argon2
            .hash_password(plaintext_password.as_bytes(), &salt)
            .map_err(|e| anyhow::anyhow!("failed to hash configured password: {e}"))?
            .to_string();

        Ok(Self {
            username,
            password_hash,
            sessions: RwLock::new(HashMap::new()),
            login_attempts: RwLock::new(HashMap::new()),
        })
    }

    /// Returns true if `client_key` (e.g. remote IP) is currently locked
    /// out from further login attempts.
    pub fn is_locked_out(&self, client_key: &str) -> bool {
        let attempts = self.login_attempts.read().unwrap();
        if let Some((count, first_attempt)) = attempts.get(client_key) {
            if first_attempt.elapsed() < LOGIN_ATTEMPT_WINDOW && *count >= MAX_LOGIN_ATTEMPTS {
                return true;
            }
        }
        false
    }

    fn record_failed_attempt(&self, client_key: &str) {
        let mut attempts = self.login_attempts.write().unwrap();
        // Bound memory growth: an attacker with access to many source
        // addresses (trivial with IPv6's address space) could otherwise
        // accumulate unbounded entries here, since an entry only gets
        // touched again if that same exact IP comes back. Sweeping on
        // every failed attempt keeps this self-limiting even under
        // sustained attack, at the cost of an O(n) scan proportional to
        // exactly the entries this same growth would otherwise leave
        // behind forever.
        attempts.retain(|_, (_, first_attempt)| first_attempt.elapsed() < LOGIN_ATTEMPT_WINDOW);
        let entry = attempts
            .entry(client_key.to_string())
            .or_insert((0, Instant::now()));
        if entry.1.elapsed() > LOGIN_ATTEMPT_WINDOW {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
    }

    fn clear_attempts(&self, client_key: &str) {
        self.login_attempts.write().unwrap().remove(client_key);
    }

    /// Verifies credentials and, on success, creates and returns a new
    /// session token. Username comparison and password verification both
    /// run regardless of whether the username matches, so a mistyped
    /// username doesn't respond measurably faster than a wrong password
    /// (a small timing-side-channel precaution).
    pub fn login(&self, client_key: &str, username: &str, password: &str) -> Option<String> {
        if self.is_locked_out(client_key) {
            return None;
        }

        let username_ok = constant_time_eq(username.as_bytes(), self.username.as_bytes());
        let password_ok = PasswordHash::new(&self.password_hash)
            .ok()
            .map(|hash| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &hash)
                    .is_ok()
            })
            .unwrap_or(false);

        if username_ok && password_ok {
            self.clear_attempts(client_key);
            Some(self.create_session())
        } else {
            self.record_failed_attempt(client_key);
            None
        }
    }

    fn create_session(&self) -> String {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes);
        let mut sessions = self.sessions.write().unwrap();
        // Same bounded-growth reasoning as record_failed_attempt: an
        // expired session otherwise sits in memory forever unless
        // validate_session happens to be called again with that exact
        // token. Sweeping here keeps this self-limiting.
        sessions.retain(|_, created| created.elapsed() < SESSION_LIFETIME);
        sessions.insert(token.clone(), Instant::now());
        token
    }

    pub fn validate_session(&self, token: &str) -> bool {
        let mut sessions = self.sessions.write().unwrap();
        match sessions.get(token) {
            Some(created) if created.elapsed() < SESSION_LIFETIME => true,
            Some(_) => {
                sessions.remove(token);
                false
            }
            None => false,
        }
    }

    pub fn logout(&self, token: &str) {
        self.sessions.write().unwrap().remove(token);
    }
}

/// Compares two byte strings in constant time, regardless of where they
/// first differ, to avoid leaking length/content via response timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        // Still walk a full comparison of equal length so this branch
        // doesn't return meaningfully faster than the equal-length path.
        let filler = vec![0u8; a.len()];
        let mut _diff = 0u8;
        for (x, y) in a.iter().zip(filler.iter()) {
            _diff |= x ^ y;
        }
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn build_session_cookie(token: &str, secure: bool) -> String {
    let secure_flag = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{secure_flag}",
        SESSION_LIFETIME.as_secs()
    )
}

pub fn build_logout_cookie(secure: bool) -> String {
    let secure_flag = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{secure_flag}")
}

pub fn extract_session_token(cookie_header: Option<&str>) -> Option<String> {
    let header = cookie_header?;
    for part in header.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix(&format!("{SESSION_COOKIE_NAME}=")) {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}
