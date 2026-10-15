use axum::extract::{ConnectInfo, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::sync::Arc;

use crate::{auth, AppState};

// ---------- shared helpers ----------

fn session_token_from_headers(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    auth::extract_session_token(cookie_header)
}

/// Extractor-free auth check, called at the top of every protected
/// handler. Kept as an explicit call (rather than an axum middleware
/// extractor) so it's obvious, reading any single handler, exactly what
/// gates access to it.
pub fn require_auth(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    let token = session_token_from_headers(headers);
    let ok = token
        .as_deref()
        .map(|t| state.auth.validate_session(t))
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "not logged in").into_response())
    }
}

#[derive(Serialize)]
pub struct ErrorBody {
    error: String,
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(ErrorBody { error: msg.into() })).into_response()
}

// ---------- auth endpoints ----------

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<LoginRequest>,
) -> Response {
    let client_key = addr.ip().to_string();

    if state.auth.is_locked_out(&client_key) {
        return err(
            StatusCode::TOO_MANY_REQUESTS,
            "too many failed login attempts, try again in 15 minutes",
        );
    }

    match state.auth.login(&client_key, &body.username, &body.password) {
        Some(token) => {
            let cookie = auth::build_session_cookie(&token, state.secure_cookies);
            let mut resp = Json(serde_json::json!({ "ok": true })).into_response();
            resp.headers_mut()
                .insert(header::SET_COOKIE, cookie.parse().unwrap());
            resp
        }
        None => err(StatusCode::UNAUTHORIZED, "invalid username or password"),
    }
}

pub async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(token) = session_token_from_headers(&headers) {
        state.auth.logout(&token);
    }
    let cookie = auth::build_logout_cookie(state.secure_cookies);
    let mut resp = Json(serde_json::json!({ "ok": true })).into_response();
    resp.headers_mut()
        .insert(header::SET_COOKIE, cookie.parse().unwrap());
    resp
}

pub async fn session_status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let logged_in = require_auth(&state, &headers).is_ok();
    // Version comes from Cargo.toml at compile time, so the frontend
    // can display which build it's actually talking to.
    Json(serde_json::json!({
        "logged_in": logged_in,
        "version": env!("CARGO_PKG_VERSION"),
    }))
    .into_response()
}

// ---------- note endpoints ----------

#[derive(Serialize)]
pub struct NoteMetaOut {
    title: String,
    modified: u64,
    pinned: bool,
}

pub async fn list_notes(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_auth(&state, &headers) {
        return resp;
    }
    match state.store.list() {
        Ok(notes) => {
            // store.list() already sorts by last-modified - that's the
            // right fallback order, but recently *viewed* notes (which
            // may not have been edited at all) take priority over it,
            // and pinned notes take priority over that. Split into
            // "pinned, in pin order" followed by "recent, in view
            // order" followed by "everything else, in the existing
            // modified-time order".
            let pinned_titles = state.store.pinned_titles();
            let recent_titles = state.store.recent_titles();
            let pinned_set: std::collections::HashSet<&str> =
                pinned_titles.iter().map(|t| t.as_str()).collect();
            let mut by_title: std::collections::HashMap<String, NoteMetaOut> = notes
                .into_iter()
                .map(|n| {
                    let pinned = pinned_set.contains(n.title.as_str());
                    (
                        n.title.clone(),
                        NoteMetaOut {
                            title: n.title,
                            modified: n.modified,
                            pinned,
                        },
                    )
                })
                .collect();

            let mut ordered = Vec::with_capacity(by_title.len());
            for title in &pinned_titles {
                if let Some(meta) = by_title.remove(title) {
                    ordered.push(meta);
                }
            }
            for title in &recent_titles {
                if let Some(meta) = by_title.remove(title) {
                    ordered.push(meta);
                }
            }
            let mut rest: Vec<NoteMetaOut> = by_title.into_values().collect();
            rest.sort_by(|a, b| b.modified.cmp(&a.modified));
            ordered.extend(rest);

            Json(ordered).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn get_note(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(title): axum::extract::Path<String>,
) -> Response {
    if let Err(resp) = require_auth(&state, &headers) {
        return resp;
    }
    match state.store.read(&title) {
        Ok(note) => {
            state.store.record_view(&title);
            Json(note).into_response()
        }
        Err(_) => err(StatusCode::NOT_FOUND, "note not found"),
    }
}

#[derive(Deserialize)]
pub struct CreateNoteRequest {
    title: String,
    content: String,
}

pub async fn create_note(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateNoteRequest>,
) -> Response {
    if let Err(resp) = require_auth(&state, &headers) {
        return resp;
    }
    let title = match crate::store::sanitize_title(&body.title) {
        Ok(t) => t,
        Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
    };
    if state.store.exists(&title) {
        return err(StatusCode::CONFLICT, "a note with this title already exists");
    }
    if let Err(e) = state.store.write(&title, &body.content) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    state.search.update_note(&title, Some(&body.content));
    Json(serde_json::json!({ "title": title })).into_response()
}

#[derive(Deserialize)]
pub struct UpdateNoteRequest {
    /// New title, if the note is being renamed. Omit to keep the same title.
    #[serde(default)]
    new_title: Option<String>,
    content: String,
}

pub async fn update_note(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(title): axum::extract::Path<String>,
    Json(body): Json<UpdateNoteRequest>,
) -> Response {
    if let Err(resp) = require_auth(&state, &headers) {
        return resp;
    }
    if !state.store.exists(&title) {
        return err(StatusCode::NOT_FOUND, "note not found");
    }

    let final_title = if let Some(new_title) = body.new_title.as_deref() {
        let new_title = match crate::store::sanitize_title(new_title) {
            Ok(t) => t,
            Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
        };
        if new_title != title {
            if let Err(e) = state.store.rename(&title, &new_title) {
                return err(StatusCode::CONFLICT, e.to_string());
            }
            state.search.rename_note(&title, &new_title);
        }
        new_title
    } else {
        title.clone()
    };

    if let Err(e) = state.store.write(&final_title, &body.content) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    state.search.update_note(&final_title, Some(&body.content));
    Json(serde_json::json!({ "title": final_title })).into_response()
}

pub async fn delete_note(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(title): axum::extract::Path<String>,
) -> Response {
    if let Err(resp) = require_auth(&state, &headers) {
        return resp;
    }
    if let Err(e) = state.store.delete(&title) {
        return err(StatusCode::NOT_FOUND, e.to_string());
    }
    state.search.update_note(&title, None);
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct PinNoteRequest {
    pinned: bool,
}

pub async fn pin_note(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(title): axum::extract::Path<String>,
    Json(body): Json<PinNoteRequest>,
) -> Response {
    if let Err(resp) = require_auth(&state, &headers) {
        return resp;
    }
    if !state.store.exists(&title) {
        return err(StatusCode::NOT_FOUND, "note not found");
    }
    if let Err(e) = state.store.set_pinned(&title, body.pinned) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    Json(serde_json::json!({ "title": title, "pinned": body.pinned })).into_response()
}

// ---------- search ----------

#[derive(Deserialize)]
pub struct SearchParams {
    q: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    title: String,
    score: usize,
}

pub async fn search_notes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<SearchParams>,
) -> Response {
    if let Err(resp) = require_auth(&state, &headers) {
        return resp;
    }
    let results = state
        .search
        .search(&params.q)
        .into_iter()
        .take(50)
        .map(|(title, score)| SearchResult { title, score })
        .collect::<Vec<_>>();
    Json(results).into_response()
}

// ---------- attachments ----------

const MAX_UPLOAD_BYTES: usize = 20 * 1024 * 1024; // 20MB per file

fn content_type_for(filename: &str) -> &'static str {
    match filename.rsplit_once('.').map(|(_, ext)| ext.to_lowercase()) {
        Some(ext) => match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "pdf" => "application/pdf",
            "txt" => "text/plain; charset=utf-8",
            _ => "application/octet-stream",
        },
        None => "application/octet-stream",
    }
}

pub async fn upload_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut multipart: axum::extract::Multipart,
) -> Response {
    if let Err(resp) = require_auth(&state, &headers) {
        return resp;
    }

    let field = match multipart.next_field().await {
        Ok(Some(field)) => field,
        Ok(None) => return err(StatusCode::BAD_REQUEST, "no file field in upload"),
        Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
    };

    let original_name = field
        .file_name()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "upload".to_string());

    let bytes = match field.bytes().await {
        Ok(b) => b,
        Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
    };
    if bytes.len() > MAX_UPLOAD_BYTES {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "file exceeds the 20MB limit");
    }

    match state.store.save_file(&original_name, &bytes) {
        Ok(saved_name) => Json(serde_json::json!({
            "filename": saved_name,
            "url": format!("/api/files/{saved_name}"),
        }))
        .into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

pub async fn get_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(filename): axum::extract::Path<String>,
) -> Response {
    // Same cookie-session check as every other route. Because the
    // browser attaches cookies to <img src="/api/files/...">
    // requests automatically (it's a same-origin request either way),
    // attachments get the same access control as the notes themselves
    // - nothing is reachable by a logged-out visitor just because it's
    // an <img> tag rather than a fetch() call.
    if let Err(resp) = require_auth(&state, &headers) {
        return resp;
    }
    match state.store.read_file(&filename) {
        Ok(bytes) => {
            let mut resp = bytes.into_response();
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                content_type_for(&filename).parse().unwrap(),
            );
            resp
        }
        Err(_) => err(StatusCode::NOT_FOUND, "file not found"),
    }
}

// ---------- export / import ----------

/// Days-since-epoch to (year, month, day), Howard Hinnant's
/// `civil_from_days` algorithm - public domain, widely used (it's the
/// same math behind libc++'s <chrono>). Pulled in as ~10 lines instead
/// of a whole date/time dependency, since a stamped export filename is
/// the only place this app needs a calendar date at all.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn today_ymd() -> (i64, u32, u32) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    civil_from_days(secs.div_euclid(86400))
}

pub async fn export_notes(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_auth(&state, &headers) {
        return resp;
    }

    let notes = match state.store.list() {
        Ok(n) => n,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let files = match state.store.list_files() {
        Ok(f) => f,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let mut buf = Vec::new();
    let build_result = (|| -> anyhow::Result<()> {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for meta in &notes {
            let note = state.store.read_exact(&meta.title)?;
            zip.start_file(format!("{}.md", meta.title), options)?;
            zip.write_all(note.content.as_bytes())?;
        }
        for filename in &files {
            let bytes = state.store.read_file(filename)?;
            zip.start_file(format!("files/{filename}"), options)?;
            zip.write_all(&bytes)?;
        }
        zip.finish()?;
        Ok(())
    })();

    if let Err(e) = build_result {
        return err(StatusCode::INTERNAL_SERVER_ERROR, format!("failed to build export archive: {e}"));
    }

    let (y, m, d) = today_ymd();
    let filename = format!("{y:04}-{m:02}-{d:02}_notes.zip");

    let mut resp = buf.into_response();
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{filename}\"").parse().unwrap(),
    );
    resp
}

#[derive(Serialize)]
pub struct ImportSummary {
    imported_notes: usize,
    imported_files: usize,
}

pub async fn import_notes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut multipart: axum::extract::Multipart,
) -> Response {
    if let Err(resp) = require_auth(&state, &headers) {
        return resp;
    }

    let field = match multipart.next_field().await {
        Ok(Some(f)) => f,
        Ok(None) => return err(StatusCode::BAD_REQUEST, "no file field in upload"),
        Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
    };
    let original_name = field.file_name().unwrap_or("upload").to_string();
    let bytes = match field.bytes().await {
        Ok(b) => b,
        Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
    };

    let mut imported_notes = 0usize;
    let mut imported_files = 0usize;

    // Zip bombs: a maliciously crafted archive can be a few KB
    // compressed but decompress to gigabytes. The request body limit
    // only caps the *compressed* upload size, which does nothing
    // against this - the cap has to be enforced on the decompressed
    // read itself, not trusted from the zip's own declared size
    // (which can be forged in a crafted file).
    const MAX_ENTRY_SIZE: u64 = MAX_UPLOAD_BYTES as u64; // same cap as a single-file upload
    const MAX_TOTAL_IMPORT_SIZE: u64 = 200 * 1024 * 1024; // generous for a real vault, not for an attack
    let mut total_decompressed: u64 = 0;

    // Sniff the actual zip magic number rather than trusting the
    // filename/extension, since that's what determines whether this
    // can be parsed as an archive at all.
    let is_zip = bytes.len() >= 4 && bytes[0..4] == [0x50, 0x4b, 0x03, 0x04];

    if is_zip {
        let cursor = std::io::Cursor::new(bytes.as_ref());
        let mut archive = match zip::ZipArchive::new(cursor) {
            Ok(a) => a,
            Err(e) => return err(StatusCode::BAD_REQUEST, format!("not a valid zip file: {e}")),
        };
        for i in 0..archive.len() {
            let mut entry = match archive.by_index(i) {
                Ok(e) => e,
                Err(_) => continue,
            };
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            let mut content = Vec::new();
            // Read at most MAX_ENTRY_SIZE + 1 bytes: if that's exactly
            // what we get back, the entry is over the limit (rather
            // than coincidentally exactly at it), so skip it.
            let mut bounded = (&mut entry).take(MAX_ENTRY_SIZE + 1);
            if bounded.read_to_end(&mut content).is_err() {
                continue;
            }
            if content.len() as u64 > MAX_ENTRY_SIZE {
                continue;
            }
            total_decompressed += content.len() as u64;
            if total_decompressed > MAX_TOTAL_IMPORT_SIZE {
                return err(
                    StatusCode::BAD_REQUEST,
                    "import archive is too large once decompressed",
                );
            }

            if let Some(rest) = name.strip_prefix("files/") {
                if rest.is_empty() {
                    continue;
                }
                if state.store.save_file(rest, &content).is_ok() {
                    imported_files += 1;
                }
            } else if name.ends_with(".md") && !name.contains('/') {
                let title = name.trim_end_matches(".md");
                if let Ok(text) = String::from_utf8(content) {
                    if let Ok(final_title) = state.store.import_note(title, &text) {
                        state.search.update_note(&final_title, Some(&text));
                        imported_notes += 1;
                    }
                }
            }
        }
    } else if original_name.to_lowercase().ends_with(".md") {
        let title = original_name.trim_end_matches(".md").trim_end_matches(".MD");
        match String::from_utf8(bytes.to_vec()) {
            Ok(text) => match state.store.import_note(title, &text) {
                Ok(final_title) => {
                    state.search.update_note(&final_title, Some(&text));
                    imported_notes += 1;
                }
                Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
            },
            Err(_) => return err(StatusCode::BAD_REQUEST, "file is not valid UTF-8 text"),
        }
    } else {
        return err(
            StatusCode::BAD_REQUEST,
            "expected a .md file or a .zip export archive",
        );
    }

    Json(ImportSummary {
        imported_notes,
        imported_files,
    })
    .into_response()
}
