// Notespice - a self-hosted, database-less markdown notes app.
// Copyright (C) 2026 Lightmorphic Ltd.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License version 3, as
// published by the Free Software Foundation. It is distributed WITHOUT
// ANY WARRANTY; see the LICENSE file, or <https://www.gnu.org/licenses/>.

mod auth;
mod handlers;
mod search;
mod store;

use auth::Auth;
use axum::routing::{get, post};
use axum::Router;
use search::SearchIndex;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use store::Store;
use axum::http::{header, HeaderValue};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

pub struct AppState {
    pub store: Store,
    pub search: SearchIndex,
    pub auth: Auth,
    pub secure_cookies: bool,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

// Two worker threads, not one per CPU core. This is a single-person
// notes app: the default would park a thread (and its stack) per core
// on a big home-lab box for no benefit. Two still means a slow request
// - a large export, say - can't stall everything else.
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let username = env_or("NOTES_USERNAME", "admin");
    let password = std::env::var("NOTES_PASSWORD").map_err(|_| {
        anyhow::anyhow!(
            "NOTES_PASSWORD environment variable is required, set it to a strong password"
        )
    })?;
    if password.len() < 8 {
        anyhow::bail!("NOTES_PASSWORD must be at least 8 characters");
    }
    // Two separate directories, on purpose: NOTES_DIR is the actual
    // vault (notes + their files/ subfolder) - back this up, sync it,
    // whatever you like. NOTES_DATA_DIR is app-only bookkeeping
    // (the recently-viewed list and the pinned-notes list) that isn't
    // a note at all; losing it just resets sidebar ordering and
    // unpins everything, nothing more.
    let notes_dir = PathBuf::from(env_or("NOTES_DIR", "/notes"));
    let data_dir = PathBuf::from(env_or("NOTES_DATA_DIR", "/data"));
    let port: u16 = env_or("NOTES_PORT", "8080").parse()?;
    let secure_cookies = env_or("NOTES_INSECURE_COOKIES", "false") != "true";

    let store = Store::new(notes_dir, data_dir)?;
    let search = SearchIndex::new();

    // Build the search index from whatever's already on disk. The
    // index is purely a cache - if this app has never run before,
    // or someone dropped .md files in by hand, this is where they
    // get picked up.
    let notes = store.list()?;
    let mut loaded = Vec::with_capacity(notes.len());
    for meta in &notes {
        if let Ok(note) = store.read(&meta.title) {
            loaded.push((meta.title.clone(), note.content));
        }
    }
    search.rebuild(loaded.iter().map(|(t, c)| (t.as_str(), c.as_str())));
    tracing::info!("indexed {} existing note(s)", loaded.len());

    let auth = Auth::new(username, &password)?;

    let state = Arc::new(AppState {
        store,
        search,
        auth,
        secure_cookies,
    });

    if !secure_cookies {
        tracing::warn!(
            "NOTES_INSECURE_COOKIES=true, session cookies will be sent without the Secure flag. \
             Only use this for local testing over plain HTTP, never in production."
        );
    }

    let api = Router::new()
        .route("/login", post(handlers::login))
        .route("/logout", post(handlers::logout))
        .route("/session", get(handlers::session_status))
        .route(
            "/notes",
            get(handlers::list_notes).post(handlers::create_note),
        )
        .route(
            "/notes/:title",
            get(handlers::get_note)
                .put(handlers::update_note)
                .delete(handlers::delete_note),
        )
        .route("/notes/:title/pin", post(handlers::pin_note))
        .route("/search", get(handlers::search_notes))
        .route("/files", post(handlers::upload_file))
        .route("/files/:filename", get(handlers::get_file))
        .route("/export", get(handlers::export_notes))
        .route("/import", post(handlers::import_notes));

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(ServeDir::new("static").append_index_html_on_directories(true))
        .layer(RequestBodyLimitLayer::new(25 * 1024 * 1024)) // 25MB - covers the 20MB attachment cap plus multipart overhead
        // Security headers set by the app itself, so every deployment
        // gets them, proxied or not. The CSP allows exactly what the
        // frontend actually does: own-origin scripts only (app.js has
        // no inline scripts), inline styles (contenteditable editing
        // needs them), and images from anywhere over https since notes
        // can embed images by URL.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
                 img-src 'self' https: data:; object-src 'none'; base-uri 'none'; \
                 frame-ancestors 'none'; form-action 'self'",
            ),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}
