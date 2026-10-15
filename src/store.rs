//! Flat-file note storage.
//!
//! There is no database. Every note is a single `.md` file in the data
//! directory, and the *filename* (without extension) is the note's title.
//! That's the whole storage model - you can `ls` the data directory, open
//! a note in any text editor, `rsync` it, back it up with plain files, and
//! nothing about the app owns your data in a way you can't get to.

use anyhow::{anyhow, bail, Context, Result};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, serde::Serialize)]
pub struct NoteMeta {
    pub title: String,
    pub modified: u64, // unix seconds
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Note {
    pub title: String,
    pub content: String,
    pub modified: u64,
}

/// Turn a user-supplied title into a filesystem-safe filename with no
/// possibility of escaping the data directory.
///
/// This is the single most security-relevant function in the app: every
/// title the client sends passes through here before it ever touches the
/// filesystem. We use an allow-list, not a deny-list - anything that
/// isn't explicitly permitted is stripped, so there's no `../`, no null
/// bytes, no NTFS/reserved-name tricks to worry about.
/// Same allow-list approach as `sanitize_title`, but for attachment
/// filenames: keeps the extension, replaces spaces with `-` (these
/// names end up in URLs, unlike note titles which stay purely internal
/// path segments), and applies the identical anti-path-traversal
/// guarantees.
pub fn sanitize_filename(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("filename cannot be empty");
    }
    if trimmed.len() > 200 {
        bail!("filename is too long (max 200 characters)");
    }

    let cleaned: String = trimmed
        .chars()
        .map(|c| match c {
            c if c.is_alphanumeric() => c,
            '-' | '_' | '.' => c,
            ' ' => '-',
            _ => '-',
        })
        .collect();

    // Collapse repeated dashes left by the substitution above...
    let mut collapsed = String::with_capacity(cleaned.len());
    let mut prev_dash = false;
    for c in cleaned.chars() {
        if c == '-' {
            if !prev_dash {
                collapsed.push(c);
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }

    // ...then strip any leading run of dots/dashes in one pass. Doing
    // this as a single combined trim (rather than trimming dots, then
    // separately trimming dashes) is what makes the function a true
    // fixed point: sanitize_filename(sanitize_filename(x)) always
    // equals sanitize_filename(x). An earlier version trimmed these
    // separately, which meant re-sanitizing an already-clean name could
    // still shave characters off it - exactly the kind of drift that
    // must never happen between the name we write to disk and the name
    // we report back to the client.
    let cleaned = collapsed
        .trim_start_matches(|c: char| c == '.' || c == '-')
        .to_string();

    if cleaned.is_empty() {
        bail!("filename contains no usable characters");
    }
    Ok(cleaned)
}

pub fn sanitize_title(title: &str) -> Result<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        bail!("title cannot be empty");
    }
    if trimmed.len() > 200 {
        bail!("title is too long (max 200 characters)");
    }

    let cleaned: String = trimmed
        .chars()
        .map(|c| match c {
            // Allow letters, numbers, spaces, and a small set of safe
            // punctuation. Everything else (including `/`, `\`, `..`,
            // control characters, null bytes) is dropped.
            c if c.is_alphanumeric() => c,
            ' ' | '-' | '_' | '(' | ')' | ',' | '.' | '\'' => c,
            _ => ' ',
        })
        .collect();

    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_matches('.').trim().to_string();

    if cleaned.is_empty() {
        bail!("title contains no usable characters");
    }
    Ok(cleaned)
}

pub struct Store {
    root: PathBuf,
    files_root: PathBuf,
    app_data_root: PathBuf,
}

impl Store {
    /// `root` holds notes (.md) and their `files/` subfolder - the
    /// actual vault, meant to be backed up. `app_data_root` holds only
    /// app-internal state that isn't a note (`.recent.json`, the
    /// recently-viewed list, and `.pinned.json`, the pinned-notes
    /// list) - separate on purpose, so it can live on different
    /// storage than the notes themselves without either directory
    /// containing a mix of "your data" and "the app's own
    /// bookkeeping".
    pub fn new(root: PathBuf, app_data_root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&root)
            .with_context(|| format!("creating notes directory at {}", root.display()))?;
        // Attachments (images, PDFs, anything else dropped into a note)
        // live in a "files" subfolder of the same notes directory, so
        // the whole notes vault - text and attachments together - is
        // still just one bind-mounted volume in docker-compose.
        let files_root = root.join("files");
        std::fs::create_dir_all(&files_root)
            .with_context(|| format!("creating files directory at {}", files_root.display()))?;
        std::fs::create_dir_all(&app_data_root).with_context(|| {
            format!("creating app data directory at {}", app_data_root.display())
        })?;
        Ok(Self {
            root,
            files_root,
            app_data_root,
        })
    }

    fn path_for(&self, title: &str) -> Result<PathBuf> {
        let safe = sanitize_title(title)?;
        let path = self.root.join(format!("{safe}.md"));

        // Belt-and-braces: even though sanitize_title() should make this
        // unreachable, verify the resulting path is still inside root
        // before we ever read/write/delete it.
        let parent = path
            .parent()
            .ok_or_else(|| anyhow!("invalid note path"))?;
        if parent.canonicalize().ok().as_deref() != Some(self.root.as_path())
            && parent != self.root
        {
            bail!("resolved path escaped the data directory");
        }
        Ok(path)
    }

    pub fn list(&self) -> Result<Vec<NoteMeta>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(NoteMeta {
                title: stem.to_string(),
                modified,
            });
        }
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(out)
    }

    pub fn read(&self, title: &str) -> Result<Note> {
        let path = self.path_for(title)?;
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("note '{title}' not found"))?;
        let modified = std::fs::metadata(&path)?
            .modified()?
            .duration_since(SystemTime::UNIX_EPOCH)?
            .as_secs();
        Ok(Note {
            title: title.to_string(),
            content,
            modified,
        })
    }

    /// Like `read`, but for internal callers that already have an
    /// *exact* title straight from `list()` - used by export, which
    /// otherwise re-sanitizes an already-real filename and can look
    /// for the wrong path. `list()` reports whatever filenames
    /// genuinely exist (including files placed on disk outside the
    /// app, which the app deliberately supports), so titles from it
    /// may contain characters the sanitizer would normally strip from
    /// untrusted input - re-running them through the sanitizer here
    /// would silently look for a different file than the one that
    /// exists. Still confined to `root` by construction, since the
    /// title came from enumerating that same directory.
    pub fn read_exact(&self, title: &str) -> Result<Note> {
        let path = self.root.join(format!("{title}.md"));
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("note '{title}' not found"))?;
        let modified = std::fs::metadata(&path)?
            .modified()?
            .duration_since(SystemTime::UNIX_EPOCH)?
            .as_secs();
        Ok(Note {
            title: title.to_string(),
            content,
            modified,
        })
    }

    pub fn exists(&self, title: &str) -> bool {
        self.path_for(title)
            .map(|p| p.exists())
            .unwrap_or(false)
    }

    pub fn write(&self, title: &str, content: &str) -> Result<()> {
        let path = self.path_for(title)?;
        // Write to a temp file then rename, so a crash mid-write never
        // leaves a half-written note on disk.
        let tmp_path = path.with_extension("md.tmp");
        std::fs::write(&tmp_path, content)?;
        std::fs::rename(&tmp_path, &path)?;
        Ok(())
    }

    pub fn delete(&self, title: &str) -> Result<()> {
        let path = self.path_for(title)?;
        std::fs::remove_file(&path).with_context(|| format!("note '{title}' not found"))?;

        let mut recent = self.load_recent();
        let before = recent.len();
        recent.retain(|t| t != title);
        if recent.len() != before {
            self.save_recent(&recent);
        }

        let mut pinned = self.load_pinned();
        let before = pinned.len();
        pinned.retain(|t| t != title);
        if pinned.len() != before {
            let _ = self.write_pinned(&pinned);
        }

        Ok(())
    }

    /// Rename a note (used when a client-side title edit changes the
    /// title). Fails if the destination already exists.
    pub fn rename(&self, old_title: &str, new_title: &str) -> Result<()> {
        let old_path = self.path_for(old_title)?;
        let new_path = self.path_for(new_title)?;
        if old_path == new_path {
            return Ok(());
        }
        if new_path.exists() {
            bail!("a note titled '{new_title}' already exists");
        }
        std::fs::rename(&old_path, &new_path)?;

        let mut recent = self.load_recent();
        for t in recent.iter_mut() {
            if t == old_title {
                *t = new_title.to_string();
            }
        }
        self.save_recent(&recent);

        let mut pinned = self.load_pinned();
        let mut pinned_changed = false;
        for t in pinned.iter_mut() {
            if t == old_title {
                *t = new_title.to_string();
                pinned_changed = true;
            }
        }
        if pinned_changed {
            let _ = self.write_pinned(&pinned);
        }

        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Reads a JSON array of titles from `path`, shared by both the
    /// recently-viewed and pinned-notes lists below - same on-disk
    /// shape, same "missing or unreadable file just means an empty
    /// list" fallback. What differs between the two is how a *write*
    /// failure is handled (best-effort vs reported to the caller), so
    /// only the read side is common.
    fn load_title_list(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default()
    }

    // ---------- recently-viewed tracking ----------
    //
    // Separate from "last modified" - opening a note you don't edit
    // should still bring it to the top of the list. Kept as a small
    // capped JSON file rather than a database; it's app state, not a
    // note, so it lives in its own directory entirely (app_data_root,
    // distinct from the notes vault) and is fine to lose or reset -
    // worst case, the sidebar order rebuilds itself as you keep
    // opening notes.

    const RECENT_LIMIT: usize = 10;

    fn recent_path(&self) -> PathBuf {
        self.app_data_root.join(".recent.json")
    }

    fn load_recent(&self) -> Vec<String> {
        Self::load_title_list(&self.recent_path())
    }

    fn save_recent(&self, list: &[String]) {
        // Best-effort: a failure here shouldn't break note viewing.
        if let Ok(json) = serde_json::to_string(list) {
            let _ = std::fs::write(self.recent_path(), json);
        }
    }

    /// Records that `title` was just opened, moving it to the front of
    /// the recently-viewed list (deduplicating if it was already
    /// present) and capping the list at `RECENT_LIMIT` entries.
    pub fn record_view(&self, title: &str) {
        let mut recent = self.load_recent();
        recent.retain(|t| t != title);
        recent.insert(0, title.to_string());
        recent.truncate(Self::RECENT_LIMIT);
        self.save_recent(&recent);
    }

    /// The recently-viewed titles, most-recent-first. Titles for notes
    /// that no longer exist are left for the caller to filter out -
    /// this just reports what's on file.
    pub fn recent_titles(&self) -> Vec<String> {
        self.load_recent()
    }

    // ---------- pinned notes ----------
    //
    // Same shape as the recently-viewed list above, and in the same
    // place: a small JSON file of titles in app_data_root, not a
    // database and not anything written into the notes themselves. A
    // pin is a preference about the sidebar, not part of the note, so
    // the .md files on disk stay exactly as plain as they were - you
    // can still open the whole vault in any editor and see nothing but
    // your own text.
    //
    // The one thing this list is *not* is best-effort. Losing the
    // recently-viewed list just reshuffles the sidebar and it rebuilds
    // itself as you keep working; losing a pin silently drops
    // something you deliberately asked for, so `set_pinned` reports a
    // failed write back to the caller instead of swallowing it.

    fn pinned_path(&self) -> PathBuf {
        self.app_data_root.join(".pinned.json")
    }

    fn load_pinned(&self) -> Vec<String> {
        Self::load_title_list(&self.pinned_path())
    }

    fn write_pinned(&self, list: &[String]) -> Result<()> {
        let json = serde_json::to_string(list)?;
        std::fs::write(self.pinned_path(), json).with_context(|| {
            format!("saving pinned notes to {}", self.pinned_path().display())
        })?;
        Ok(())
    }

    /// The pinned titles, in the order they were pinned (oldest pin
    /// first). The sidebar renders the pinned group in this order, so
    /// pinning a note adds it to the bottom of the pinned group rather
    /// than jumping it above notes pinned earlier.
    pub fn pinned_titles(&self) -> Vec<String> {
        self.load_pinned()
    }

    /// Pins or unpins a note. Idempotent - pinning an already-pinned
    /// note is a no-op that doesn't touch the disk.
    pub fn set_pinned(&self, title: &str, pinned: bool) -> Result<()> {
        let mut list = self.load_pinned();
        let already = list.iter().any(|t| t == title);
        if pinned == already {
            return Ok(());
        }
        if pinned {
            list.push(title.to_string());
        } else {
            list.retain(|t| t != title);
        }
        self.write_pinned(&list)
    }

    // ---------- attachments (files/ subfolder) ----------

    /// Resolves an *already-sanitized* filename to a path inside the
    /// files directory, verifying it didn't somehow escape. Callers
    /// must run untrusted input through `sanitize_filename` first -
    /// this does not re-sanitize, because doing so on an
    /// already-cleaned name previously caused the on-disk filename to
    /// drift from the name reported back to the client (sanitization
    /// isn't perfectly idempotent on edge-case input like leading
    /// dashes/dots, so running it twice could silently produce a
    /// different name the second time).
    fn resolve_file_path(&self, safe_name: &str) -> Result<PathBuf> {
        let path = self.files_root.join(safe_name);
        let parent = path.parent().ok_or_else(|| anyhow!("invalid file path"))?;
        if parent.canonicalize().ok().as_deref() != Some(self.files_root.as_path())
            && parent != self.files_root
        {
            bail!("resolved path escaped the files directory");
        }
        Ok(path)
    }

    /// Saves an uploaded attachment under a filesystem-safe name derived
    /// from the original filename, appending "-2", "-3", etc. if a file
    /// of that name already exists (same collision strategy as note
    /// titles). Returns the name it was actually saved under.
    pub fn save_file(&self, original_name: &str, bytes: &[u8]) -> Result<String> {
        let safe = sanitize_filename(original_name)?;
        let (stem, ext) = match safe.rsplit_once('.') {
            Some((s, e)) => (s.to_string(), format!(".{e}")),
            None => (safe.clone(), String::new()),
        };

        let mut candidate = safe.clone();
        let mut n = 2;
        while self.files_root.join(&candidate).exists() {
            candidate = format!("{stem}-{n}{ext}");
            n += 1;
        }

        let path = self.resolve_file_path(&candidate)?;
        std::fs::write(&path, bytes)?;
        Ok(candidate)
    }

    /// Lists attachment filenames under files/, for export.
    pub fn list_files(&self) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.files_root)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    out.push(name.to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Imports a note under a filesystem-safe name derived from the
    /// given title, appending "(1)", "(2)", etc. on collision - an
    /// import never silently overwrites an existing note. Returns the
    /// title it was actually saved under.
    pub fn import_note(&self, title: &str, content: &str) -> Result<String> {
        let safe = sanitize_title(title)?;
        let mut candidate = safe.clone();
        let mut n = 1;
        while self.root.join(format!("{candidate}.md")).exists() {
            candidate = format!("{safe}({n})");
            n += 1;
        }
        self.write(&candidate, content)?;
        Ok(candidate)
    }

    pub fn read_file(&self, filename: &str) -> Result<Vec<u8>> {
        let safe = sanitize_filename(filename)?;
        let path = self.resolve_file_path(&safe)?;
        std::fs::read(&path).with_context(|| format!("file '{filename}' not found"))
    }
}
