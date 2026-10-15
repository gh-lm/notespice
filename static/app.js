// Notespice - a self-hosted, database-less markdown notes app.
// Copyright (C) 2026 Lightmorphic Ltd.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License version 3, as
// published by the Free Software Foundation. It is distributed WITHOUT
// ANY WARRANTY; see the LICENSE file, or <https://www.gnu.org/licenses/>.

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Non-fatal: the app works fine without a service worker, it
      // just won't be installable as a PWA or cache its shell.
    });
  });
}

// ---------- tiny state ----------
let currentTitle = null;      // title of the note currently open, or null
let originalTitle = null;     // title as last saved, to detect renames
let mode = "wysiwyg";         // "wysiwyg" | "raw"
let saveTimer = null;
let savePending = false;
let allNotes = [];            // last full note list, for restoring after a cleared search

const el = (id) => document.getElementById(id);

// Without this, browsers are inconsistent about what Enter produces
// in a contenteditable (Chrome defaults to <div>, and the exact
// nesting can vary by cursor position) - forcing a real <p> per Enter
// keeps the DOM shape predictable and matching what htmlToMd expects.
document.execCommand("defaultParagraphSeparator", false, "p");
// Force semantic tags (<b>, <i>) from formatting commands, never
// styled <span>s. The serializer reads styled spans too as a fallback,
// but semantic tags are the shape everything here is tested against.
document.execCommand("styleWithCSS", false, false);

// ---------- API helpers ----------
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("not logged in");
  }
  return res;
}

async function apiJson(path, options = {}) {
  const res = await api(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || "request failed");
  }
  return res.json();
}

// ---------- screens ----------
function showLogin() {
  el("login-screen").hidden = false;
  el("app-screen").hidden = true;
}

function showApp() {
  el("login-screen").hidden = true;
  el("app-screen").hidden = false;
}

// ---------- login ----------
el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = el("login-username").value;
  const password = el("login-password").value;
  const errorEl = el("login-error");
  errorEl.hidden = true;

  let res;
  try {
    res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (err) {
    console.error("Login request failed:", err);
    errorEl.textContent = "could not reach the server";
    errorEl.hidden = false;
    return;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "login failed" }));
    errorEl.textContent = body.error || "login failed";
    errorEl.hidden = false;
    return;
  }

  showApp();
  try {
    await loadNotes();
  } catch (err) {
    console.error("Failed to load notes after login:", err);
    showFailure("Logged in, but your notes would not load: " + err.message);
  }
});

el("logout-btn").addEventListener("click", async () => {
  await flushPendingSave();
  await fetch("/api/logout", { method: "POST" });
  currentTitle = null;
  showLogin();
});

// ---------- export / import ----------

// Single-note export, in a choice of formats - separate from "export
// everything" below, which always produces one zip of the whole vault.
// Markdown is a plain client-side Blob download (the note's content is
// already in hand, no server round trip needed); PDF reuses the
// browser's own print-to-PDF rather than a rendering library, in
// keeping with this app pulling in nothing external - see the
// @media print rules in style.css for what's hidden/shown.
function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function closeExportNoteMenu() {
  el("export-note-menu").hidden = true;
  el("export-note-btn").setAttribute("aria-expanded", "false");
}

el("export-note-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!currentTitle) return;
  const menu = el("export-note-menu");
  const opening = menu.hidden;
  closeExportNoteMenu();
  if (opening) {
    menu.hidden = false;
    el("export-note-btn").setAttribute("aria-expanded", "true");
  }
});

document.addEventListener("click", (e) => {
  if (el("export-note-menu").hidden) return;
  const wrap = el("export-note-btn").closest(".export-note-wrap");
  if (wrap && !wrap.contains(e.target)) closeExportNoteMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeExportNoteMenu();
});

el("export-note-menu").addEventListener("click", (e) => {
  const btn = e.target.closest(".export-menu-item");
  if (!btn || !currentTitle) return;
  closeExportNoteMenu();
  const format = btn.dataset.format;
  if (format === "md") {
    downloadBlob(currentTitle + ".md", currentMarkdown(), "text/markdown;charset=utf-8");
  } else if (format === "pdf") {
    // Always render through mdToHtml for print, regardless of which
    // mode (Writer/Markdown) is on screen - printing the raw <textarea>
    // directly doesn't paginate its content onto printed pages at all
    // in most browsers.
    el("print-note").innerHTML = mdToHtml(currentMarkdown());
    const previousTitle = document.title;
    document.title = currentTitle;
    window.print();
    document.title = previousTitle;
    el("print-note").innerHTML = "";
  }
});

el("export-btn").addEventListener("click", () => {
  window.location.href = "/api/export";
});

el("import-btn").addEventListener("click", () => el("import-file-input").click());

el("import-file-input").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;

  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/import", { method: "POST", body: form });
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "import failed" }));
      showFailure(body.error || "The import failed.");
      return;
    }
    const { imported_notes, imported_files } = await res.json();
    // Nothing to announce: the imported notes appear in the list below,
    // which is the answer. A count in a box would only be in the way.
    clearFailure();
    await loadNotes();
  } catch (err) {
    showFailure(err.message);
  }
});

// ---------- collapsible sidebar ----------
let sidebarPinned = true;

function isNarrow() {
  return window.innerWidth <= 700;
}
function setSidebarOpen(open) {
  document.querySelector(".sidebar").classList.toggle("collapsed", !open);
  el("sidebar-backdrop").classList.toggle("visible", open);
}
el("sidebar-backdrop").addEventListener("click", () => setSidebarOpen(false));
el("menu-toggle-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const sidebar = document.querySelector(".sidebar");
  setSidebarOpen(sidebar.classList.contains("collapsed"));
});
el("pin-btn").addEventListener("click", () => {
  sidebarPinned = !sidebarPinned;
  el("pin-btn").classList.toggle("active", sidebarPinned);
  el("pin-btn").setAttribute("aria-pressed", String(sidebarPinned));
  if (sidebarPinned) setSidebarOpen(true);
});
// Clicking anywhere in the right-hand pane (not just typing) also
// gets the sidebar out of the way - unless pinned, in which case it
// stays open regardless.
document.querySelector(".editor-pane").addEventListener("click", () => {
  if (!sidebarPinned) setSidebarOpen(false);
});
setSidebarOpen(!isNarrow());

// ---------- note list ----------
async function loadNotes() {
  allNotes = await apiJson("/notes");
  renderNoteList(allNotes);
  if (!currentTitle && allNotes.length) {
    await openNote(allNotes[0].title);
  } else if (!allNotes.length) {
    el("empty-state").hidden = false;
  }
}

const PIN_ICON =
  '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H10L9.5 6.25L12 8.75V9.75H4V8.75L6.5 6.25Z"/><path d="M8 9.75L8 14.25"/></svg>';

async function togglePin(title, pinned) {
  await apiJson(`/notes/${encodeURIComponent(title)}/pin`, {
    method: "POST",
    body: JSON.stringify({ pinned }),
  });
  // Re-fetch rather than patching the local `pinned` flag in place:
  // the sidebar groups pinned notes into one contiguous run, and the
  // server is the one place that knows the correct pinned-then-recent
  // order after a toggle - patching the flag alone would leave the
  // client's copy of the list in the wrong order for that grouping.
  allNotes = await apiJson("/notes");
  renderNoteList(allNotes);
}

function renderNoteList(notes) {
  const list = el("note-list");
  list.innerHTML = "";

  // Pinned notes are already sorted first by the server - just find
  // where that run ends so a "Pinned" label can separate it from the
  // rest, the same way a real pinned-items list reads anywhere else.
  const pinnedCount = notes.findIndex((n) => !n.pinned);
  const splitAt = pinnedCount === -1 ? notes.length : pinnedCount;

  if (splitAt > 0 && splitAt < notes.length) {
    const heading = document.createElement("li");
    heading.className = "note-list-heading";
    heading.textContent = "Pinned";
    list.appendChild(heading);
  }

  notes.forEach((note, i) => {
    if (splitAt > 0 && i === splitAt) {
      const heading = document.createElement("li");
      heading.className = "note-list-heading";
      heading.textContent = "Notes";
      list.appendChild(heading);
    }

    const li = document.createElement("li");
    li.className = "note-list-item";
    li.dataset.title = note.title;
    if (note.title === currentTitle) li.classList.add("active");

    const titleSpan = document.createElement("span");
    titleSpan.className = "note-list-title";
    titleSpan.textContent = note.title;
    li.appendChild(titleSpan);

    const pinBtn = document.createElement("button");
    pinBtn.className = "note-pin-btn";
    pinBtn.type = "button";
    pinBtn.innerHTML = PIN_ICON;
    pinBtn.title = note.pinned ? "Unpin note" : "Pin note to top";
    pinBtn.setAttribute("aria-label", pinBtn.title);
    if (note.pinned) pinBtn.classList.add("active");
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(note.title, !note.pinned).catch((err) => showFailure(err.message));
    });
    li.appendChild(pinBtn);

    li.addEventListener("click", () => {
      openNote(note.title);
      if (isNarrow() && !sidebarPinned) setSidebarOpen(false);
    });
    list.appendChild(li);
  });
}

function closeSearchResults() {
  const results = el("search-results");
  if (results.hidden) return;
  results.hidden = true;
  if (currentTitle) el("editor").hidden = false;
  else el("empty-state").hidden = false;
}

async function showSearchResults(query) {
  query = query.trim();
  if (!query) return;
  const matches = await apiJson(`/search?q=${encodeURIComponent(query)}`);

  el("empty-state").hidden = true;
  el("editor").hidden = true;
  const results = el("search-results");
  results.hidden = false;
  results.innerHTML = `<div class="results-heading">${matches.length} result${matches.length === 1 ? "" : "s"} for "${query.replace(/</g, "&lt;")}"</div>`;
  for (const { title } of matches) {
    const item = document.createElement("div");
    item.className = "result-item";
    const titleDiv = document.createElement("div");
    titleDiv.className = "result-title";
    titleDiv.textContent = title;
    item.appendChild(titleDiv);
    item.addEventListener("click", () => {
      results.hidden = true;
      openNote(title);
      if (isNarrow() && !sidebarPinned) setSidebarOpen(false);
    });
    results.appendChild(item);
  }
}

let searchDebounce = null;
el("search-box").addEventListener("input", (e) => {
  closeSearchResults();
  clearTimeout(searchDebounce);
  const q = e.target.value.trim().toLowerCase();
  searchDebounce = setTimeout(() => {
    renderNoteList(q ? allNotes.filter((n) => n.title.toLowerCase().includes(q)) : allNotes);
  }, 100);
});

el("search-box").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    showSearchResults(e.target.value);
  }
});

// Only excluding the search box itself meant "/" was stolen from every
// other typing surface too - a note title, the Writer editor, the raw
// Markdown textarea - so a URL like "https://example.com" typed into a
// note yanked focus to search mid-keystroke and dropped the slash.
// Skip the shortcut whenever focus is already on anything you can type
// into, not just the search box specifically.
function isTypingTarget(node) {
  if (!node) return false;
  if (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT") return true;
  return !!node.isContentEditable;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !isTypingTarget(document.activeElement) && !el("app-screen").hidden) {
    e.preventDefault();
    el("search-box").focus();
  }
});

// ---------- markdown <-> HTML conversion ----------
// Notespice's own converter - no external editor library, no CDN
// dependency. Supports the full GFM feature set this app's toolbar
// exposes: headings 1-6, bold/italic/strikethrough/inline code, all
// three list types with nesting, blockquotes, fenced code blocks,
// tables, footnotes, GitHub-style callouts, links, and images.
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Only allow schemes that can't execute code when clicked/loaded:
// http(s), mailto, and schemeless (relative paths, #anchors - covers
// our own /api/files/... upload URLs). Anything else (javascript:,
// vbscript:, data:, etc.) is neutralized to "#" rather than inserted
// as-is - a note containing `[x](javascript:...)`, typed directly or
// imported from a file, would otherwise execute arbitrary script in
// the logged-in session when clicked.
function sanitizeUrl(url) {
  const trimmed = (url || "").trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return "#";
}

function inlineMdToHtml(text) {
  let html = escapeHtml(text);
  const codes = [];
  html = html.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return "\u0000C" + (codes.length - 1) + "\u0000";
  });
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => '<img src="' + sanitizeUrl(url) + '" alt="' + alt + '">');
  html = html.replace(/\[\^([^\]]+)\]/g, '<sup class="footnote-ref" data-fn="$1">$1</sup>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => '<a href="' + sanitizeUrl(url) + '">' + label + "</a>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\u0000C(\d+)\u0000/g, (_, i) => "<code>" + codes[+i] + "</code>");
  return html;
}

function inlineNodeToMd(node) {
  let out = "";
  const children = Array.from(node.childNodes);
  let i = 0;
  while (i < children.length) {
    const child = children[i];
    if (child.nodeType === 1 && child.tagName.toLowerCase() === "br") {
      let runLength = 0;
      let j = i;
      while (j < children.length && children[j].nodeType === 1 && children[j].tagName.toLowerCase() === "br") {
        runLength++;
        j++;
      }
      // A single <br> is a hard line break, and GFM's syntax for that
      // is two trailing spaces before the newline. Serializing it as a
      // bare "\n" (a soft break) silently downgraded any imported
      // note's real hard breaks on resave - a bare newline is exactly
      // what a soft break (a literal \n in paragraph text) already
      // round-trips as, so the two DOM forms need two distinct
      // serializations to both survive. Visually identical either way,
      // both here (white-space: pre-line) and on GitHub.
      if (runLength === 1) out += "  \n";
      else if (runLength === 2) out += "\n\n";
      else out += "\n\n" + "<br>\n".repeat(runLength - 2);
      i = j;
      continue;
    }
    if (child.nodeType === 3) { out += child.textContent; i++; continue; }
    if (child.nodeType !== 1) { i++; continue; }
    const tag = child.tagName.toLowerCase();
    if (tag === "input" && child.type === "checkbox") { i++; continue; }
    const inner = inlineNodeToMd(child);
    // An inline formatting element whose content is only whitespace,
    // breaks, or zero-width-space fillers must not emit its markers -
    // a <b> holding nothing but a stray <br> would otherwise become
    // "**\n**", visible junk asterisks after the next reparse.
    const innerVisible = inner.replace(/\s/g, "").replace(/\u200B/g, "") !== "";
    if (tag === "strong" || tag === "b") out += innerVisible ? "**" + inner + "**" : inner;
    else if (tag === "em" || tag === "i") out += innerVisible ? "*" + inner + "*" : inner;
    else if (tag === "del" || tag === "s" || tag === "strike") out += innerVisible ? "~~" + inner + "~~" : inner;
    else if (tag === "code") out += innerVisible ? "`" + inner + "`" : inner;
    else if (tag === "a") out += "[" + inner + "](" + child.getAttribute("href") + ")";
    else if (tag === "img") out += "![" + (child.getAttribute("alt") || "") + "](" + child.getAttribute("src") + ")";
    else if (tag === "sup" && child.classList.contains("footnote-ref")) out += "[^" + child.getAttribute("data-fn") + "]";
    else if (tag === "ul" || tag === "ol") { /* handled separately by caller */ }
    else if (tag === "span") {
      // Some browsers express formatting as styled spans instead of
      // semantic tags (execCommand's CSS mode, or styling that
      // survived from elsewhere). Read the common ones off the inline
      // style so that formatting isn't silently dropped on save.
      let styled = inner;
      if (innerVisible && child.style) {
        const fw = String(child.style.fontWeight || "");
        const deco = String(child.style.textDecorationLine || child.style.textDecoration || "");
        if (deco.indexOf("line-through") !== -1) styled = "~~" + styled + "~~";
        if (child.style.fontStyle === "italic") styled = "*" + styled + "*";
        if (fw === "bold" || fw === "bolder" || parseInt(fw, 10) >= 600) styled = "**" + styled + "**";
      }
      out += styled;
    }
    else out += inner;
    i++;
  }
  return out;
}

function inlineOnly(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll("ul, ol").forEach((n) => n.remove());
  const cb = clone.querySelector('input[type="checkbox"]');
  if (cb) cb.remove();
  return inlineNodeToMd(clone).replace(/^\s+/, "");
}

const HEADING_PATTERNS = [
  [/^######\s+/, "h6"], [/^#####\s+/, "h5"], [/^####\s+/, "h4"],
  [/^###\s+/, "h3"], [/^##\s+/, "h2"], [/^#\s+/, "h1"],
];

// Used to know when to stop consuming lines into the current
// paragraph - a paragraph continues across lines until a blank line
// *or* a line that starts a different kind of block.
function isBlockStart(line) {
  if (/^```/.test(line)) return true;
  if (/^\|.*\|\s*$/.test(line)) return true;
  if (HEADING_PATTERNS.some((p) => p[0].test(line))) return true;
  if (/^\[\^([^\]]+)\]:\s*/.test(line)) return true;
  if (/^>\s?/.test(line)) return true;
  if (/^(---|\*\*\*)\s*$/.test(line)) return true;
  if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) return true;
  return false;
}

let footnoteDefs;
function mdToHtmlInner(md) {
  const lines = md.split("\n");
  let html = "";
  let i = 0;
  const stack = [];

  function closeListsTo(indent) {
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      const frame = stack.pop();
      if (frame.liOpen) html += "</li>";
      html += "</" + frame.type + ">";
      // Closing a nested list also closes the parent item it was
      // nested inside (the <li> stays open across a sublist so the
      // sublist ends up a *child* of that <li>, not a sibling of it).
      if (stack.length && stack[stack.length - 1].liOpen) {
        html += "</li>";
        stack[stack.length - 1].liOpen = false;
      }
    }
  }
  function closeAllLists() { closeListsTo(-1); }

  while (i < lines.length) {
    const raw = lines[i];

    if (/^```/.test(raw)) {
      closeAllLists();
      const lang = raw.replace(/^```/, "").trim();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      html += '<pre' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : "") + '><code>' + escapeHtml(code.join("\n")) + "</code></pre>";
      i++;
      continue;
    }

    if (/^\|.*\|\s*$/.test(raw) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeAllLists();
      const headerCells = raw.replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim()));
        i++;
      }
      html += "<table><thead><tr>" + headerCells.map((c) => "<th>" + inlineMdToHtml(c) + "</th>").join("") + "</tr></thead><tbody>";
      rows.forEach((r) => {
        html += "<tr>" + r.map((c) => "<td>" + inlineMdToHtml(c) + "</td>").join("") + "</tr>";
      });
      html += "</tbody></table>";
      continue;
    }

    const headingHit = HEADING_PATTERNS.find((p) => p[0].test(raw));
    if (headingHit) {
      closeAllLists();
      html += "<" + headingHit[1] + ">" + inlineMdToHtml(raw.replace(headingHit[0], "")) + "</" + headingHit[1] + ">";
      i++;
      continue;
    }

    const fnDefMatch = raw.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (fnDefMatch) {
      closeAllLists();
      footnoteDefs.push({ id: fnDefMatch[1], html: inlineMdToHtml(fnDefMatch[2]) });
      i++;
      continue;
    }

    if (/^>\s?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(raw)) {
      closeAllLists();
      const alertType = raw.match(/\[!(\w+)\]/i)[1].toUpperCase();
      const firstLine = raw.replace(/^>\s?\[!\w+\]\s*/i, "");
      const body = [firstLine];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, "")); i++; }
      const bodyText = body.join(" ").trim();
      html += '<div class="md-alert md-alert-' + alertType.toLowerCase() + '"><p class="md-alert-title">' + alertType.charAt(0) + alertType.slice(1).toLowerCase() + "</p>" +
        (bodyText ? "<p>" + inlineMdToHtml(bodyText) + "</p>" : "") + "</div>";
      continue;
    }

    if (/^>\s?/.test(raw)) {
      closeAllLists();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i++; }
      html += "<blockquote><p>" + inlineMdToHtml(quote.join(" ")) + "</p></blockquote>";
      continue;
    }

    if (/^(---|\*\*\*)\s*$/.test(raw)) { closeAllLists(); html += "<hr>"; i++; continue; }

    const listMatch = raw.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const indent = listMatch[1].length;
      const marker = listMatch[2];
      const content = listMatch[3];
      const type = /\d+\./.test(marker) ? "ol" : "ul";
      const checkMatch = content.match(/^\[( |x|X)\]\s+(.*)$/);
      const isCheck = !!checkMatch;

      closeListsTo(indent + 1);
      if (!stack.length || stack[stack.length - 1].indent < indent) {
        stack.push({ indent, type, liOpen: false });
        html += "<" + type + (isCheck ? ' class="task-list"' : "") + ">";
      } else if (stack[stack.length - 1].indent === indent && stack[stack.length - 1].type !== type) {
        const old = stack.pop();
        if (old.liOpen) html += "</li>";
        html += "</" + old.type + ">";
        stack.push({ indent, type, liOpen: false });
        html += "<" + type + (isCheck ? ' class="task-list"' : "") + ">";
      }

      const top = stack[stack.length - 1];
      if (top.liOpen) html += "</li>";
      if (isCheck) {
        const checked = /x/i.test(checkMatch[1]);
        html += "<li><label><input type=\"checkbox\"" + (checked ? " checked" : "") + "> " + inlineMdToHtml(checkMatch[2]) + "</label>";
      } else {
        html += "<li>" + inlineMdToHtml(content);
      }
      top.liOpen = true;
      i++;
      continue;
    }

    if (raw.trim() === "") { closeAllLists(); i++; continue; }

    closeAllLists();
    // Consume an entire run of plain text - INCLUDING the blank lines
    // between its paragraphs - into a single <p>, encoding every kind
    // of break as something the caret can actually land on:
    //   soft break            -> a literal "\n"  (one line down)
    //   hard break ("  "/"\") -> <br>            (one line down)
    //   paragraph break       -> <br><br>        (a REAL blank line)
    //   each literal <br> line-> one more <br>   (one more blank line)
    // Splitting paragraphs into separate <p>s with margin gaps made
    // the blank line purely visual: arrow keys jumped straight across
    // it, unlike the Markdown textarea where every blank line is a
    // real line. This is also exactly the DOM shape typing in Writer
    // produces, so the serializer's existing <br> run-length logic
    // round-trips it unchanged.
    let paraHtml = "";
    let sep = null; // pending separator before the next text line
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        // Blank run: consume it all, then peek. Blanks before a block
        // (or the end) are separators for the join, not content.
        let j = i;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j >= lines.length || isBlockStart(lines[j])) {
          // Breaks still pending here are blank lines the writer put
          // between this text and whatever block follows it. They used
          // to be dropped on the floor, so adding a code block after a
          // few presses of Enter made those blank lines disappear.
          // Keep them; the blank run itself is still just the
          // separator, so an ordinary "text, blank line, block" is
          // unaffected.
          if (sep && sep.indexOf("<br>") === 0) paraHtml += sep;
          i = j;
          break;
        }
        sep = "<br><br>";
        i = j;
        continue;
      }
      if (isBlockStart(line)) break;
      if (/^<br\s*\/?>$/i.test(line.trim())) {
        // A literal <br> line: one additional blank line on top of
        // whatever break precedes it.
        sep = (sep && sep.indexOf("<br>") === 0 ? sep : "") + "<br>";
        i++;
        continue;
      }
      if (paraHtml !== "") paraHtml += sep === null ? "\n" : sep;
      // A region can legitimately begin with pending breaks (a note
      // whose text starts with a literal <br> line) - keep them.
      else if (sep && sep.indexOf("<br>") === 0) paraHtml += sep;
      const hardBreak = /(  +|\\)$/.test(line);
      paraHtml += inlineMdToHtml(line.replace(/(  +|\\)$/, ""));
      sep = hardBreak ? "<br>" : "\n";
      i++;
    }
    html += "<p>" + paraHtml + "</p>";
  }
  closeAllLists();

  if (footnoteDefs.length) {
    html += '<div class="footnotes"><hr><ol>';
    footnoteDefs.forEach((fn) => {
      html += '<li id="fn-' + escapeHtml(fn.id) + '">' + fn.html + "</li>";
    });
    html += "</ol></div>";
  }

  return html || "<p></p>";
}

function mdToHtml(md) {
  footnoteDefs = [];
  return mdToHtmlInner(md);
}

// Collapse line breaks inside content that must stay on a single
// markdown line (a heading, a table cell, a list item, a quote): a
// stray "\n" or "  \n" inside one of those would split the construct
// across lines and break its syntax on reparse.
function oneLine(s) {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

function serializeList(listEl, depth) {
  const lines = [];
  const isOl = listEl.tagName.toLowerCase() === "ol";
  let n = 1;
  // Walk direct children in document order rather than querying only
  // <li>s: browsers' native indent (execCommand) nests a <ul> directly
  // inside a <ul> with no wrapping <li> - technically invalid HTML,
  // but real. Querying ":scope > li" alone made such a list serialize
  // to an empty string: the entire list silently vanished on save.
  Array.from(listEl.children).forEach((child) => {
    const t = child.tagName.toLowerCase();
    if (t === "ul" || t === "ol") {
      lines.push(serializeList(child, depth + 1));
      return;
    }
    if (t !== "li") return;
    const li = child;
    const indent = "  ".repeat(depth);
    const cb = li.querySelector(':scope > label > input[type="checkbox"], :scope > input[type="checkbox"]');
    const text = oneLine(inlineOnly(li));
    if (cb) {
      lines.push(indent + "- [" + (cb.checked ? "x" : " ") + "] " + text);
    } else if (isOl) {
      lines.push(indent + (n++) + ". " + text);
    } else {
      lines.push(indent + "- " + text);
    }
    const nested = li.querySelector(":scope > ul, :scope > ol");
    if (nested) lines.push(serializeList(nested, depth + 1));
  });
  return lines.join("\n");
}

function htmlToMd(container) {
  const out = [];
  let looseBuffer = document.createElement("div");
  const flushLoose = () => {
    if (looseBuffer.childNodes.length) {
      const text = inlineNodeToMd(looseBuffer);
      const trimmed = text.replace(/^\s+|\s+$/g, "");
      if (trimmed) out.push(trimmed);
      looseBuffer = document.createElement("div");
    }
  };
  container.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      // Bare text node at the top level - a user typing straight into
      // the editor div produces exactly this. Gather into an implicit
      // paragraph rather than silently dropping it.
      looseBuffer.appendChild(node.cloneNode(true));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    // Inline elements at the top level also belong in the implicit
    // paragraph, same reasoning.
    if (["br", "strong", "b", "em", "i", "del", "s", "strike", "code", "a", "img", "sup", "span"].includes(tag)) {
      looseBuffer.appendChild(node.cloneNode(true));
      return;
    }
    // A real block element ends any implicit paragraph in progress.
    flushLoose();
    if (/^h[1-6]$/.test(tag)) out.push("#".repeat(+tag[1]) + " " + oneLine(inlineOnly(node)));
    // inlineOnly, not textContent: textContent strips every inline
    // element, so bold/italic/code inside a quote was destroyed on
    // save - "> **a** b" became "> a b" permanently.
    else if (tag === "blockquote") out.push("> " + oneLine(inlineOnly(node)));
    else if (tag === "div" && node.classList.contains("md-alert")) {
      const type = Array.from(node.classList).find((c) => c.indexOf("md-alert-") === 0).replace("md-alert-", "").toUpperCase();
      const bodyP = node.querySelector("p:not(.md-alert-title)");
      const bodyText = bodyP ? oneLine(inlineOnly(bodyP)) : "";
      out.push("> [!" + type + "]" + (bodyText ? "\n> " + bodyText : ""));
    } else if (tag === "div" && node.classList.contains("footnotes")) {
      const lines = [];
      node.querySelectorAll("li").forEach((li) => {
        const id = li.id.replace(/^fn-/, "");
        lines.push("[^" + id + "]: " + oneLine(inlineOnly(li)));
      });
      out.push(lines.join("\n\n"));
    } else if (tag === "hr") out.push("---");
    else if (tag === "pre") {
      const lang = node.getAttribute("data-lang") || "";
      // textContent alone loses line structure: a <br> inside the
      // block (what pressing Enter in a code block leaves behind)
      // contributes nothing to textContent, silently joining two code
      // lines into one. Walk the nodes and turn each <br> back into a
      // real newline.
      let codeText = "";
      (function walkPre(n) {
        n.childNodes.forEach((c) => {
          if (c.nodeType === 3) codeText += c.textContent;
          else if (c.nodeType === 1) {
            if (c.tagName.toLowerCase() === "br") codeText += "\n";
            else walkPre(c);
          }
        });
      })(node);
      codeText = codeText.replace(/\u200B/g, "").replace(/\n$/, "");
      out.push("```" + lang + "\n" + codeText + "\n```");
    } else if (tag === "ul" || tag === "ol") {
      out.push(serializeList(node, 0));
    } else if (tag === "table") {
      const headerCells = [];
      node.querySelectorAll("thead th").forEach((th) => headerCells.push(oneLine(inlineOnly(th))));
      const rows = [];
      node.querySelectorAll("tbody tr").forEach((tr) => {
        const cells = [];
        tr.querySelectorAll("td").forEach((td) => cells.push(oneLine(inlineOnly(td))));
        rows.push(cells);
      });
      const tlines = [];
      tlines.push("| " + headerCells.join(" | ") + " |");
      tlines.push("| " + headerCells.map(() => "---").join(" | ") + " |");
      rows.forEach((r) => tlines.push("| " + r.join(" | ") + " |"));
      out.push(tlines.join("\n"));
    } else if (tag === "p" || tag === "div") {
      if (node.querySelector("p, div, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, hr")) {
        // Unexpected nested block content mixed with loose text -
        // walk this node's own children directly so any loose text
        // sitting alongside a nested block isn't silently dropped
        // (recursing wholesale would skip it, since htmlToMd only
        // processes element children, not bare text nodes).
        const parts = [];
        let looseBuffer = document.createElement("div");
        const flushLoose = () => {
          if (looseBuffer.childNodes.length) {
            const text = inlineOnly(looseBuffer);
            if (text) parts.push(text);
            looseBuffer = document.createElement("div");
          }
        };
        node.childNodes.forEach((child) => {
          if (child.nodeType === 1 && /^(p|div|h[1-6]|ul|ol|blockquote|pre|table|hr)$/.test(child.tagName.toLowerCase())) {
            flushLoose();
            const wrapper = document.createElement("div");
            wrapper.appendChild(child.cloneNode(true));
            const nested = htmlToMd(wrapper);
            if (nested) parts.push(nested);
          } else {
            looseBuffer.appendChild(child.cloneNode(true));
          }
        });
        flushLoose();
        if (parts.length) out.push(parts.join("\n\n"));
      } else {
        // Preserve leading <br>s in a paragraph as explicit <br>
        // lines - otherwise inlineOnly's leading-whitespace strip
        // erases them. Without this, the 3+ consecutive Enter
        // pattern ("a\n\n<br>\nb") loses its extra <br> line when
        // switching modes back and forth: mdToHtml turns it into
        // <p><br>b</p>, then htmlToMd sees just <p>...</p> and can't
        // tell the paragraph originally started with a break.
        let leadingBrs = 0;
        let child = node.firstChild;
        while (child && child.nodeType === 1 && child.tagName.toLowerCase() === "br") {
          leadingBrs++;
          child = child.nextSibling;
        }
        let inline;
        if (leadingBrs > 0) {
          // Serialize what's left AFTER that leading run, not the
          // whole paragraph. Reading the whole thing counts the same
          // breaks twice - once as explicit <br> lines here, once
          // again inside inlineOnly - which made a paragraph of
          // nothing but blank lines grow a little longer every time
          // the note was saved and reopened.
          const rest = node.cloneNode(true);
          for (let k = 0; k < leadingBrs; k++) rest.removeChild(rest.firstChild);
          inline = inlineOnly(rest);
        } else {
          inline = inlineOnly(node);
        }
        if (leadingBrs > 0) {
          const marks = "<br>\n".repeat(leadingBrs);
          out.push(inline ? marks + inline : marks.replace(/\n$/, ""));
        } else {
          out.push(inline);
        }
      }
    }
  });
  flushLoose();
  return out.filter((s) => s).join("\n\n");
}

// ---------- editor ----------
el("new-note-btn").addEventListener("click", async () => {
  let title = "Untitled";
  let n = 1;
  // Dedupe against existing titles rather than relying on the
  // server's own collision handling, which is built for import (a
  // "(1)", "(2)" suffix), not for finding the next free "Untitled N".
  const existingTitles = new Set(allNotes.map((note) => note.title));
  while (existingTitles.has(title)) {
    n++;
    title = "Untitled " + n;
  }
  try {
    await apiJson("/notes", {
      method: "POST",
      body: JSON.stringify({ title, content: "" }),
    });
    await loadNotes();
    // loadNotes auto-opens the newest note when nothing was open, so
    // only open explicitly when that didn't already happen - opening
    // twice costs two extra requests and races a fast title edit.
    if (currentTitle !== title) await openNote(title);
    if (isNarrow()) setSidebarOpen(false);
    el("title-input").focus();
    el("title-input").select();
  } catch (e) {
    showFailure(e.message);
  }
});

async function openNote(title) {
  await flushPendingSave();
  const note = await apiJson(`/notes/${encodeURIComponent(title)}`);
  currentTitle = note.title;
  originalTitle = note.title;

  el("search-results").hidden = true;
  el("empty-state").hidden = true;
  el("editor").hidden = false;
  el("title-input").value = note.title;
  el("raw-textarea").value = note.content;
  el("wysiwyg-editor").innerHTML = mdToHtml(note.content);
  ensureTrailingParagraphAfterCodeBlock();
  // Nothing to report on opening a note: the slot only ever carries a
  // failure, and there is none yet.
  el("save-indicator").textContent = "";
  resetDeleteButton();

  // Opening a note just moved it to the front of the server's
  // recently-viewed order - re-fetch so the sidebar reflects that
  // immediately, rather than re-rendering the array from before this
  // note was opened (which is why the list previously looked like it
  // wasn't actually tracking what was last viewed).
  allNotes = await apiJson("/notes");
  renderNoteList(allNotes);
}

async function uploadFile(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/files", { method: "POST", body: form });
  if (res.status === 401) {
    showLogin();
    throw new Error("not logged in");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "upload failed" }));
    throw new Error(body.error || "upload failed");
  }
  return res.json(); // { filename, url }
}

function currentMarkdown() {
  if (mode === "wysiwyg") return htmlToMd(el("wysiwyg-editor")).replace(/\u200B/g, "");
  return el("raw-textarea").value;
}

function nextFootnoteNumber() {
  const md = currentMarkdown();
  let max = 0;
  const re = /\[\^(\d+)\]/g;
  let m;
  while ((m = re.exec(md))) max = Math.max(max, parseInt(m[1], 10));
  return max + 1;
}

// Wraps the current selection in `tagName`. If nothing is selected,
// inserts an empty element (a zero-width space, invisible) with the
// cursor placed inside it, so typing continues in that format -
// rather than inserting visible placeholder text the person then has
// to notice, select, and delete. Verified structurally with jsdom
// (both the collapsed- and selected-text paths) before shipping.
function wrapSelectionInline(tagName) {
  const s = window.getSelection();
  if (!s.rangeCount) return;
  const r = s.getRangeAt(0);
  const elNode = document.createElement(tagName);
  if (r.collapsed) {
    elNode.appendChild(document.createTextNode("\u200B"));
    r.insertNode(elNode);
    const nr = document.createRange();
    nr.setStart(elNode.firstChild, 1);
    nr.collapse(true);
    s.removeAllRanges();
    s.addRange(nr);
  } else {
    const contents = r.extractContents();
    elNode.appendChild(contents);
    r.insertNode(elNode);
    const nr2 = document.createRange();
    nr2.setStartAfter(elNode);
    nr2.collapse(true);
    s.removeAllRanges();
    s.addRange(nr2);
  }
}

// Same idea for a checklist item: no placeholder "task" text, cursor
// lands inside the label ready to type.
function insertChecklistItem(labelText) {
  const s = window.getSelection();
  if (!s.rangeCount) return;
  const r = s.getRangeAt(0);
  const ul = document.createElement("ul");
  ul.className = "task-list";
  const li = document.createElement("li");
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  label.appendChild(cb);
  const textNode = document.createTextNode(" " + (labelText || ""));
  label.appendChild(textNode);
  li.appendChild(label);
  ul.appendChild(li);
  r.deleteContents();
  r.insertNode(ul);
  const nr = document.createRange();
  nr.setStart(textNode, textNode.textContent.length);
  nr.collapse(true);
  s.removeAllRanges();
  s.addRange(nr);
}

// A code block is the one block type Enter can never get you out of
// (see the keydown handler above - inside a <pre>, Enter always inserts
// a literal newline, never exits it) and formatBlock("PRE") on the last
// paragraph leaves the <pre> as the very last element in the editor. In
// that spot there's also nothing below to click into, so a code block
// created or arrived at, at the bottom of a note, was previously a
// dead end. Same fix already used for a freshly inserted table above:
// give it a trailing empty paragraph, a click target below the block
// that isn't inside it. Safe to call anytime - it only appends when the
// very last element genuinely is a <pre>, so calling it again once that
// paragraph exists (e.g. on every keystroke, from onEditingInput) is a
// no-op.
function ensureTrailingParagraphAfterCodeBlock() {
  const editor = el("wysiwyg-editor");
  if (editor.lastElementChild && editor.lastElementChild.tagName === "PRE") {
    editor.appendChild(document.createElement("p"));
  }
}

function onEditingInput() {
  if (!sidebarPinned) setSidebarOpen(false);
  if (mode === "wysiwyg") ensureTrailingParagraphAfterCodeBlock();
  scheduleSave();
}
el("raw-textarea").addEventListener("input", onEditingInput);
el("title-input").addEventListener("input", onEditingInput);
el("wysiwyg-editor").addEventListener("input", onEditingInput);
// The editor reserves 120px of bottom padding for the floating "New
// note" button - visually that reads as empty space below whatever
// the last block is, but a click landing on that padding hits the
// editor <div> itself as its target, not any block inside it, so the
// browser never moves the cursor anywhere (the trailing paragraph
// after a code block only actually catches a click if it lands on
// that exact thin line, not the much larger empty area below it).
// When the click target is the editor container itself - meaning it
// didn't land on any specific block - send the cursor to the end of
// the last block instead, creating a trailing paragraph first if that
// last block is a code fence.
el("wysiwyg-editor").addEventListener("click", (e) => {
  const editor = el("wysiwyg-editor");
  if (e.target !== editor) return;
  // Two different clicks land on the container itself. Beside a line,
  // in the editor's side padding: put the caret on the line actually
  // clicked, at whichever end is nearer, so typing goes where the
  // writer is looking. (Doing nothing here is nearly as bad as the
  // old jump-to-the-end - the caret silently stays wherever it was,
  // and the next thing typed, or the next toolbar button, applies
  // somewhere else entirely.)
  const lastBefore = editor.lastElementChild;
  if (lastBefore && e.clientY < lastBefore.getBoundingClientRect().bottom) {
    const style = getComputedStyle(editor);
    const box = editor.getBoundingClientRect();
    const inLeft = box.left + parseFloat(style.paddingLeft) + 1;
    const inRight = box.right - parseFloat(style.paddingRight) - 1;
    const x = Math.min(Math.max(e.clientX, inLeft), inRight);
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, e.clientY);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, e.clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (range && editor.contains(range.startContainer)) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      editor.focus();
    }
    return;
  }
  ensureTrailingParagraphAfterCodeBlock();
  const last = editor.lastElementChild;
  if (!last) return;
  const range = document.createRange();
  range.selectNodeContents(last);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  editor.focus();
});
// Enter and Shift+Enter both just insert a line break - never a
// native paragraph split. What that break *means* in the saved
// markdown depends on how many land in a row (handled by
// inlineNodeToMd's run-length logic): one is a soft break, two is a
// real paragraph break, three or more adds explicit <br> lines, since
// GFM collapses any number of blank lines to a single paragraph break
// and extra ones add no visual gap on their own.
el("wysiwyg-editor").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const sel = window.getSelection();

    // Inside a list item, the custom <br> insertion below is exactly
    // wrong: it puts a line break *inside* the current item, so
    // pressing Enter could never create a second bullet - and the
    // "item<br>next" DOM it left behind serialized to markdown that
    // drifted on every mode switch. The browser's native Enter in an
    // <li> does the two things people actually expect: split into a
    // new item, and exit the list when the current item is empty. Let
    // it through untouched.
    if (sel.rangeCount) {
      let scan = sel.getRangeAt(0).startContainer;
      const editorEl = el("wysiwyg-editor");
      let inLi = false, inPre = false, preEl = null;
      while (scan && scan !== editorEl) {
        if (scan.nodeType === 1) {
          const t = scan.tagName.toLowerCase();
          if (t === "li") inLi = true;
          if (t === "pre") { inPre = true; preEl = scan; }
        }
        scan = scan.parentNode;
      }
      if (inLi) return; // native list behavior
      if (inPre) {
        // A code block is otherwise a one-way trap: Enter inside it
        // never means "leave", so typing all the way to the bottom of
        // a note with nothing after the block left no way out except a
        // precise click on a sliver of empty space below it. Two
        // Enters in a row on the already-blank last line - the same
        // "exit the block" gesture GitHub, Obsidian and VS Code's own
        // markdown editors all use - now exits into whatever follows
        // (creating an empty paragraph first if the block was the very
        // last thing in the note), instead of adding a second blank
        // line inside the fence.
        const r0 = sel.getRangeAt(0);
        const beforeRange = document.createRange();
        beforeRange.selectNodeContents(preEl);
        beforeRange.setEnd(r0.startContainer, r0.startOffset);
        const textBefore = beforeRange.toString().replace(/\u200B/g, "");
        const afterRange = document.createRange();
        afterRange.selectNodeContents(preEl);
        afterRange.setStart(r0.endContainer, r0.endOffset);
        const textAfter = afterRange.toString().replace(/\u200B/g, "");
        const atEnd = textAfter === "";
        const onBlankLine = textBefore !== "" && textBefore.endsWith("\n");
        if (atEnd && onBlankLine) {
          e.preventDefault();
          const codeChild = preEl.querySelector(":scope > code");
          const trimmedText = preEl.textContent.replace(/\u200B/g, "").replace(/\n$/, "");
          if (codeChild) {
            codeChild.textContent = trimmedText;
            Array.from(preEl.childNodes).forEach((n) => { if (n !== codeChild) n.remove(); });
          } else {
            preEl.textContent = trimmedText;
          }
          ensureTrailingParagraphAfterCodeBlock();
          const target = preEl.nextElementSibling;
          if (target) {
            const r2 = document.createRange();
            r2.selectNodeContents(target);
            r2.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r2);
          }
          onEditingInput();
          return;
        }
        // Inside a code block, a line break is a literal newline
        // character, not a <br> - the serializer reads the block's
        // text, and white-space: pre-wrap renders the \n directly.
        e.preventDefault();
        const r = sel.getRangeAt(0);
        r.deleteContents();
        const nl = document.createTextNode("\n");
        r.insertNode(nl);
        // Same trailing-invisibility problem as the <br> case below:
        // a newline with nothing after it doesn't render a visible
        // new line, so give the browser a zero-width space to hold
        // the line open until something is typed.
        if (!nl.nextSibling || (nl.nextSibling.nodeType === 3 && nl.nextSibling.textContent === "")) {
          nl.textContent = "\n\u200B";
        }
        r.setStart(nl, nl.textContent.length);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        onEditingInput();
        return;
      }
    }

    e.preventDefault();
    // Manual Range-based insertion, not execCommand("insertLineBreak")
    // - execCommand's exact DOM behavior varies by browser in ways
    // this environment has no way to verify (no real browser, and
    // jsdom doesn't implement execCommand at all), and it's the most
    // likely cause of a real data-loss bug: an unpredictable resulting
    // structure the markdown parser doesn't walk correctly. This
    // mirrors wrapSelectionInline's approach below, which is directly
    // testable and already verified.
    if (sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();

      // If the cursor is inside an inline formatting element
      // (<strong>, <em>, <code>, etc.) and sits at the very end (or
      // start) of it, insert the <br> outside that element rather
      // than inside it. Inserting inside produces broken markdown
      // like `**a\n**\nb` - the closing marker gets orphaned onto
      // its own line, which no renderer treats as valid emphasis.
      const inlineTags = new Set(["strong", "b", "em", "i", "del", "s", "strike", "code", "a", "sup", "span"]);
      const editor = el("wysiwyg-editor");
      let inlineAncestor = null;
      let walk = range.startContainer;
      while (walk && walk !== editor) {
        if (walk.nodeType === 1 && inlineTags.has(walk.tagName.toLowerCase())) {
          inlineAncestor = walk;
        }
        walk = walk.parentNode;
      }

      const br = document.createElement("br");
      let insertedOutside = false;
      if (inlineAncestor) {
        // Content-based check: is there any actual text between the
        // cursor and the end (or start) of the inline element?
        // compareBoundaryPoints returns "not equal" for (textNode, len)
        // vs (parent, childIndex+1) even though they point to the same
        // visual spot, so we can't use it directly.
        const afterRange = document.createRange();
        afterRange.setStart(range.endContainer, range.endOffset);
        afterRange.setEnd(inlineAncestor, inlineAncestor.childNodes.length);
        const atEnd = afterRange.toString().replace(/\u200B/g, "") === "";
        const beforeRange = document.createRange();
        beforeRange.setStart(inlineAncestor, 0);
        beforeRange.setEnd(range.startContainer, range.startOffset);
        const atStart = beforeRange.toString().replace(/\u200B/g, "") === "";
        if (atEnd) {
          inlineAncestor.after(br);
          insertedOutside = true;
        } else if (atStart) {
          inlineAncestor.before(br);
          insertedOutside = true;
        }
      }
      if (!insertedOutside) range.insertNode(br);

      // Range.insertNode() on a collapsed range positioned at the very
      // start of an existing text node (e.g. right after a previous
      // Enter's zero-width-space filler, with the cursor sitting at its
      // start) splits that node in two, leaving an empty text node
      // *before* the <br>. It's invisible, but it's a real sibling -
      // and it breaks the run-length count of consecutive <br>s just
      // below, used to tell a soft break from a paragraph break from an
      // explicit <br> line. Without this, three Enters in a row can
      // leave one dangling behind the first <br>, splitting what should
      // be a single run of 3 into a run of 1 and a run of 2 - so the
      // third Enter silently does nothing instead of adding the extra
      // line, since GFM collapses runs of 2 and "1 then 2" identically.
      if (br.previousSibling && br.previousSibling.nodeType === 3 && br.previousSibling.textContent === "") {
        br.previousSibling.remove();
      }

      // A <br> with nothing after it (the common case - pressing
      // Enter at the end of what you're typing) doesn't render a new
      // visible line by itself in most browsers; nothing appears to
      // happen until something follows it. Without this, the natural
      // reaction is to press Enter again, which inserts a *second*
      // real <br> - turning what should be one simple line break into
      // a paragraph break by the run-length logic below. A zero-width
      // space is a real character, not a <br>, so it gives the
      // browser something to render a line for without being counted
      // as a second break when saved.
      const next = br.nextSibling;
      const nextIsEmpty = next && next.nodeType === 3 && next.textContent === "";
      if (!next || nextIsEmpty) {
        // Reuse the empty text node if there is one (from splitting
        // existing text at the cursor) rather than leaving it dangling
        // and creating a second node next to it.
        const filler = nextIsEmpty ? next : document.createTextNode("");
        filler.textContent = "\u200B";
        if (!next) br.after(filler);
        range.setStart(filler, 0);
      } else {
        range.setStartAfter(br);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  // Browsers auto-wire Ctrl+U to underline for any contenteditable,
  // with no code of ours calling for it - underline has no GFM
  // representation, so block it explicitly rather than relying only
  // on the serializer's fallback to silently drop it on save.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
    e.preventDefault();
  }
});
// Force paste to plain text only. Rich HTML from Word/Google Docs/a
// webpage can carry formatting with zero GFM representation (colors,
// underline, fonts, justified/centered text), and - more importantly -
// can carry arbitrary markup that bypasses the markdown converter's
// own URL sanitization entirely, unlike anything typed or imported
// through this app's own paths.
el("wysiwyg-editor").addEventListener("paste", (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData("text/plain");
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const lines = text.split("\n");
  let lastNode = null;
  lines.forEach((line, i) => {
    if (i > 0) {
      const br = document.createElement("br");
      range.insertNode(br);
      range.setStartAfter(br);
      lastNode = br;
    }
    if (line) {
      const textNode = document.createTextNode(line);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      lastNode = textNode;
    }
  });
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  onEditingInput();
});
// Native drag-and-drop has the same problem - dropped content can
// carry a browser's own rich HTML/URLs straight into the DOM. Direct
// users to the Upload/Attach toolbar buttons instead, which go
// through this app's own upload endpoint.
el("wysiwyg-editor").addEventListener("drop", (e) => {
  e.preventDefault();
});
el("wysiwyg-editor").addEventListener("change", (e) => {
  if (e.target && e.target.type === "checkbox") onEditingInput();
});

// ---------- format bar ----------
const ICONS = {
  bold: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.25 3.25L5.25 12.75"/><path d="M5.25 3.25H8.75A2.375 2.375 0 0 1 8.75 8H5.25"/><path d="M5.25 8H9.25A2.375 2.375 0 0 1 9.25 12.75H5.25"/></svg>',
  italic: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 12.75L9.5 3.25"/><path d="M8 3.25L12.25 3.25"/><path d="M3.75 12.75L8 12.75"/></svg>',
  strike: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.75 5.1A2.9 2.9 0 0 0 8.9 3.1H7.3A2.4 2.4 0 0 0 5.7 7.3"/><path d="M2.5 8L13.5 8"/><path d="M4.9 10.9A2.9 2.9 0 0 0 7.75 12.9H8.6A2.4 2.4 0 0 0 10.6 9.6"/></svg>',
  code: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.75 4.75L2.5 8L5.75 11.25"/><path d="M10.25 4.75L13.5 8L10.25 11.25"/></svg>',
  ul: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="3" cy="4.25" r="1.15" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="3" cy="11.75" r="1.15" fill="currentColor" stroke="none"/><path d="M6.5 4.25L13.5 4.25"/><path d="M6.5 8L13.5 8"/><path d="M6.5 11.75L13.5 11.75"/></svg>',
  ol: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.9 3L2.7 2.5" stroke-width="1.15"/><path d="M2.7 2.5L2.7 4.9" stroke-width="1.15"/><path d="M1.85 4.9L3.6 4.9" stroke-width="1.15"/><path d="M1.8 7.0A1.15 1.15 0 0 1 3.95 7.6C3.95 8.5 1.8 9.0 1.8 9.4H4.05" stroke-width="1.15"/><path d="M1.85 11.4A1.1 1.1 0 1 1 2.8 12.95H2.5" stroke-width="1.15"/><path d="M2.5 12.95H2.8A1.1 1.1 0 1 1 1.85 14.5" stroke-width="1.15"/><path d="M6.5 3.7L13.75 3.7"/><path d="M6.5 8.1L13.75 8.1"/><path d="M6.5 12.5L13.75 12.5"/></svg>',
  checklist: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.9" y="2.75" width="4.3" height="4.3" rx="1.3"/><path d="M3.1 4.95L3.9 5.75L5.1 4.25" stroke-width="1.15"/><rect x="1.9" y="8.95" width="4.3" height="4.3" rx="1.3"/><path d="M3.1 11.15L3.9 11.95L5.1 10.45" stroke-width="1.15"/><path d="M8.4 4.9L14 4.9"/><path d="M8.4 11.1L14 11.1"/></svg>',
  indent: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.25L13.5 3.25"/><path d="M6.75 6.4L13.5 6.4"/><path d="M6.75 9.6L13.5 9.6"/><path d="M2.5 12.75L13.5 12.75"/><path d="M2.5 6.4L4.5 8L2.5 9.6"/></svg>',
  outdent: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.25L13.5 3.25"/><path d="M6.75 6.4L13.5 6.4"/><path d="M6.75 9.6L13.5 9.6"/><path d="M2.5 12.75L13.5 12.75"/><path d="M4.5 6.4L2.5 8L4.5 9.6"/></svg>',
  quote: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.1 3.75L3.1 12.25"/><path d="M6.75 5.25L13.25 5.25"/><path d="M6.75 8L13.25 8"/><path d="M6.75 10.75L13.25 10.75"/></svg>',
  codeblock: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2"/><path d="M6.1 6.6L4.5 8L6.1 9.4"/><path d="M9.9 6.6L11.5 8L9.9 9.4"/></svg>',
  hr: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.9L11 3.9" opacity=".35"/><path d="M2 8L14 8"/><path d="M2.5 12.1L9.5 12.1" opacity=".35"/></svg>',
  footnote: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.6L10.4 5.6"/><circle cx="12.4" cy="4.3" r="1.05" fill="currentColor" stroke="none"/><path d="M2.5 9L13.5 9"/><path d="M2.5 12.2L9.75 12.2"/></svg>',
  link: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.9 9.1A2.75 2.75 0 0 0 10.8 9.1L13.1 6.8A2.75 2.75 0 0 0 9.2 2.9L8.1 4"/><path d="M9.1 6.9A2.75 2.75 0 0 0 5.2 6.9L2.9 9.2A2.75 2.75 0 0 0 6.8 13.1L7.9 12"/></svg>',
  image: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M1.75 11L5.5 7.5L9.5 11.25M8 9.75L10 8L14.25 11.5"/><circle cx="10.5" cy="5.75" r="1.1"/></svg>',
  upload: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.75V2.75"/><path d="M5.25 5.5L8 2.75L10.75 5.5"/><path d="M2.75 10.75V12.5A1.5 1.5 0 0 0 4.25 14H11.75A1.5 1.5 0 0 0 13.25 12.5V10.75"/></svg>',
  attach: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7.5L7.25 12.25A3 3 0 0 1 3 8L8.5 2.5A2 2 0 0 1 11.25 5.25L5.9 10.6A1 1 0 0 1 4.5 9.2L9.5 4.25"/></svg>',
  table: '<svg aria-hidden="true" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2"/><path d="M1.75 6.4L14.25 6.4"/><path d="M6 3.25L6 12.75"/><path d="M10 3.25L10 12.75"/></svg>',
};

const LABELS = {
  bold: "Bold", italic: "Italic", strike: "Strikethrough", code: "Inline code",
  ul: "Bullet list", ol: "Numbered list", checklist: "Checkbox list",
  indent: "Indent", outdent: "Outdent",
  quote: "Blockquote", codeblock: "Code block", hr: "Horizontal rule", footnote: "Footnote",
  link: "Link", image: "Image by URL", upload: "Upload image", attach: "Attach file", table: "Insert table",
};

const GROUPS = [
  ["bold", "italic", "strike", "code"],
  ["ul", "ol", "checklist", "outdent", "indent"],
  ["quote", "codeblock", "hr", "footnote"],
  ["link", "image", "upload", "attach", "table"],
];

function buildFormatBar() {
  const bar = el("format-bar");
  bar.innerHTML = "";

  const headingSelect = document.createElement("select");
  headingSelect.id = "heading-select";
  headingSelect.title = "Text style";
  headingSelect.setAttribute("aria-label", "Text style");
  ["Text style", "Paragraph", "Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6"].forEach((label, i) => {
    const opt = document.createElement("option");
    opt.value = i === 0 ? "" : i === 1 ? "P" : "H" + (i - 1);
    opt.textContent = label;
    if (i === 0) { opt.disabled = true; opt.selected = true; }
    headingSelect.appendChild(opt);
  });
  bar.appendChild(headingSelect);
  bar.appendChild(sep());

  GROUPS.forEach((group) => {
    group.forEach((cmd) => {
      const btn = document.createElement("button");
      btn.dataset.cmd = cmd;
      btn.setAttribute("aria-label", LABELS[cmd]);
      btn.innerHTML = ICONS[cmd];
      bar.appendChild(btn);
    });
    bar.appendChild(sep());
  });

  const alertSelect = document.createElement("select");
  alertSelect.id = "alert-select";
  alertSelect.setAttribute("aria-label", "GitHub-style callout");
  ["Callout…", "Note", "Tip", "Important", "Warning", "Caution"].forEach((label, i) => {
    const opt = document.createElement("option");
    opt.value = i === 0 ? "" : label.toUpperCase();
    opt.textContent = label;
    if (i === 0) { opt.disabled = true; opt.selected = true; }
    alertSelect.appendChild(opt);
  });
  bar.appendChild(alertSelect);

  const imageInput = document.createElement("input");
  imageInput.type = "file";
  imageInput.id = "image-upload-input";
  imageInput.accept = "image/*";
  imageInput.style.display = "none";
  bar.appendChild(imageInput);

  const attachInput = document.createElement("input");
  attachInput.type = "file";
  attachInput.id = "attach-file-input";
  attachInput.style.display = "none";
  bar.appendChild(attachInput);

  function sep() {
    const s = document.createElement("span");
    s.className = "sep";
    return s;
  }
}
buildFormatBar();

// Walks up from `node` looking for the nearest ancestor matching
// `predicate`, stopping at (and never returning) `boundary`. Shared
// by the "codeblock" command below, which needs this twice - once to
// find the block to convert, once to find the <pre> it just inserted.
function closestAncestorMatching(node, boundary, predicate) {
  while (node && node !== boundary && !predicate(node)) node = node.parentNode;
  return node === boundary ? null : node;
}

el("format-bar").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const cmd = btn.dataset.cmd;
  const editor = el("wysiwyg-editor");
  editor.focus();
  const sel = window.getSelection();
  const selectedText = sel && sel.toString();

  if (cmd === "bold") document.execCommand("bold");
  else if (cmd === "italic") document.execCommand("italic");
  else if (cmd === "strike") document.execCommand("strikeThrough");
  else if (cmd === "quote") document.execCommand("formatBlock", false, "BLOCKQUOTE");
  else if (cmd === "codeblock") {
    // execCommand("formatBlock", "PRE") turned out to be unreliable
    // (see the commit history), but building the <pre> with plain DOM
    // calls instead of any execCommand brought two problems of its
    // own: it converted the WHOLE current block's text, which for a
    // click on what looks like a blank line between two paragraphs
    // swallowed the earlier one too - this editor keeps a blank-line
    // paragraph break as <br><br> INSIDE one <p>, not as two separate
    // paragraphs - and plain DOM mutation never lands on the
    // browser's native undo stack at all, so Undo did nothing
    // afterward. insertHTML is the fix for both: still a single
    // execCommand call the browser can undo, but - unlike
    // formatBlock - it reliably inserts exactly the HTML given. When
    // there's real text after the cursor within the block, only that
    // part is selected and becomes code, leaving the rest as its own
    // paragraph - the same technique the "hr" and "footnote" buttons
    // already rely on execCommand for, to split a paragraph correctly
    // at the cursor. When there's nothing meaningful after the cursor
    // (the ordinary case right after typing, where the cursor sits at
    // the end), the whole block is selected instead, so what was just
    // typed becomes the code rather than being left untouched next to
    // a new empty block.
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const blockTags = /^(P|DIV|H[1-6]|BLOCKQUOTE|LI|PRE)$/;
      const block = closestAncestorMatching(range.startContainer, editor, (n) => n.nodeType === 1 && blockTags.test(n.tagName));
      if (!block || block.tagName !== "PRE") {
        // <br> inside a normal paragraph is a soft break - reading
        // plain textContent alone would silently join lines together,
        // same reasoning as the walkPre reader used when reading a
        // code block back out for saving.
        const walkForText = (node) => {
          let out = "";
          node.childNodes.forEach((c) => {
            if (c.nodeType === 3) out += c.textContent;
            else if (c.nodeType === 1) out += c.tagName === "BR" ? "\n" : walkForText(c);
          });
          return out;
        };
        // What becomes code: the selection if there is one, otherwise
        // just the line the cursor is on. Scoping to the line matters
        // because a whole note lives in ONE <p> here - blank lines are
        // <br><br> inside it, not separate paragraphs - so "convert
        // this block" would swallow every paragraph above the cursor
        // as well, which is exactly what it used to do.
        let target;
        if (!block) {
          target = null;
        } else if (walkForText(block).replace(/\u200B/g, "") === "") {
          // Nothing in this block at all (a brand new note): replace
          // the empty block itself rather than leaving it behind.
          // Deliberately NOT a trimmed comparison - a block holding
          // nothing but blank lines walks to "\n\n\n", and treating
          // that as empty converted the whole run of them, so pressing
          // Enter a few times and then adding a code block gave a
          // block full of blank lines instead of an empty one.
          target = document.createRange();
          target.selectNode(block);
        } else {
          // Whole lines only. A fence can't hold half a line, and
          // asking the browser to insert a <pre> over a part-line
          // range makes it flatten the block into an inline styled
          // <span> instead. So grow out to the <br> boundaries either
          // side of whatever is selected (or of the bare cursor).
          target = document.createRange();
          target.selectNodeContents(block);
          const brs = Array.from(block.querySelectorAll("br"));
          const posOf = (br) => Array.prototype.indexOf.call(br.parentNode.childNodes, br);
          for (const br of brs) {
            if (range.comparePoint(br.parentNode, posOf(br)) === -1) target.setStartAfter(br);
            else break;
          }
          for (const br of brs) {
            if (range.comparePoint(br.parentNode, posOf(br)) === 1) { target.setEndBefore(br); break; }
          }
        }
        const codeText = target
          ? walkForText(target.cloneContents()).replace(/\u200B/g, "")
          : (selectedText || "").replace(/\u200B/g, "");
        if (target) {
          sel.removeAllRanges();
          sel.addRange(target);
        }
        document.execCommand("insertHTML", false, "<pre><code>" + escapeHtml(codeText) + "</code></pre>");
        // Walk up from wherever the selection actually landed after
        // the insert, rather than searching the whole document for a
        // <pre> - a note with an existing code block further down
        // would make querySelector("pre:last-of-type") find that one
        // instead of the one just created here.
        const insertedPre = closestAncestorMatching(
          sel.rangeCount ? sel.getRangeAt(0).startContainer : null,
          editor,
          (n) => n.tagName === "PRE"
        );
        // The blank lines above the new block are the writer's, so
        // they stay put - mdToHtml keeps them now, so they survive a
        // save and reload. The one exception is a run of exactly two
        // breaks: that is a single blank line, which Markdown cannot
        // tell apart from the ordinary gap before a block, so it would
        // quietly vanish on reload. Drop it now instead, and the
        // Writer keeps matching the file. One break, or three or more,
        // are stored as written.
        if (insertedPre) {
          const prev = insertedPre.previousElementSibling;
          if (prev) {
            const trailing = [];
            let scan = prev.lastChild;
            while (scan) {
              if (scan.nodeType === 3 && scan.textContent.replace(/​/g, "") === "") { scan = scan.previousSibling; continue; }
              if (scan.nodeName === "BR") { trailing.push(scan); scan = scan.previousSibling; continue; }
              break;
            }
            if (trailing.length === 2) trailing.forEach((br) => br.remove());
          }
        }
        const insertedCode = insertedPre ? insertedPre.querySelector("code") : null;
        if (insertedCode) {
          const r = document.createRange();
          r.selectNodeContents(insertedCode);
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      }
    }
    ensureTrailingParagraphAfterCodeBlock();
  }
  else if (cmd === "ul") document.execCommand("insertUnorderedList");
  else if (cmd === "ol") document.execCommand("insertOrderedList");
  else if (cmd === "indent") document.execCommand("indent");
  else if (cmd === "outdent") document.execCommand("outdent");
  else if (cmd === "hr") document.execCommand("insertHorizontalRule");
  else if (cmd === "footnote") {
    const n = nextFootnoteNumber();
    // Built by hand, not via insertHTML: the browser rewrites a
    // pasted-in <sup class="footnote-ref"> into a plain <span> with
    // the same styles inlined, which drops the class and data-fn the
    // serializer reads - so the note ended up containing a bare "1"
    // instead of a real footnote marker.
    const sup = document.createElement("sup");
    sup.className = "footnote-ref";
    sup.setAttribute("data-fn", String(n));
    sup.textContent = String(n);
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      r.deleteContents();
      r.insertNode(sup);
      const after = document.createRange();
      after.setStartAfter(sup);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    } else {
      editor.appendChild(sup);
    }
    const fnP = document.createElement("p");
    fnP.textContent = "[^" + n + "]: ";
    editor.appendChild(fnP);
  } else if (cmd === "checklist") {
    insertChecklistItem(selectedText);
  } else if (cmd === "code") {
    wrapSelectionInline("code");
  } else if (cmd === "link") {
    const answer = await askFields([{ label: "Link address", value: "https://" }], btn);
    if (!answer || !answer[0]) return;
    const url = sanitizeUrl(answer[0]);
    if (!selectedText) document.execCommand("insertHTML", false, '<a href="' + url + '">' + escapeHtml(url) + "</a>");
    else document.execCommand("createLink", false, url);
  } else if (cmd === "image") {
    const answer = await askFields([
      { label: "Image address", value: "https://" },
      { label: "Describe the picture", value: "" },
    ], btn);
    if (!answer || !answer[0]) return;
    document.execCommand("insertHTML", false, '<img src="' + sanitizeUrl(answer[0]) + '" alt="' + escapeHtml(answer[1] || "") + '">');
  } else if (cmd === "upload") {
    el("image-upload-input").click();
    return;
  } else if (cmd === "attach") {
    el("attach-file-input").click();
    return;
  } else if (cmd === "table") {
    const answer = await askFields([
      { label: "Columns", value: "2", type: "number", min: "1", max: "20" },
      { label: "Rows, not counting the header", value: "2", type: "number", min: "1", max: "50" },
    ], btn);
    if (!answer) return;
    const cols = Math.min(20, Math.max(1, parseInt(answer[0], 10) || 2));
    const rowsN = Math.min(50, Math.max(1, parseInt(answer[1], 10) || 2));
    let t = "<table><thead><tr>";
    for (let c = 0; c < cols; c++) t += "<th>Header " + (c + 1) + "</th>";
    t += "</tr></thead><tbody>";
    for (let r = 0; r < rowsN; r++) {
      t += "<tr>";
      for (let c2 = 0; c2 < cols; c2++) t += "<td>&nbsp;</td>";
      t += "</tr>";
    }
    t += "</tbody></table><p></p>";
    document.execCommand("insertHTML", false, t);
  }
  onEditingInput();
});

el("heading-select").addEventListener("change", (e) => {
  const val = e.target.value;
  el("wysiwyg-editor").focus();
  document.execCommand("formatBlock", false, val);
  e.target.selectedIndex = 0;
  onEditingInput();
});

el("alert-select").addEventListener("change", (e) => {
  const type = e.target.value;
  el("wysiwyg-editor").focus();
  document.execCommand("insertHTML", false,
    '<div class="md-alert md-alert-' + type.toLowerCase() + '"><p class="md-alert-title">' +
    type.charAt(0) + type.slice(1).toLowerCase() + "</p><p>Add a note here.</p></div><p></p>");
  e.target.selectedIndex = 0;
  onEditingInput();
});

el("image-upload-input").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const { url } = await uploadFile(file);
    el("wysiwyg-editor").focus();
    document.execCommand("insertHTML", false, '<img src="' + sanitizeUrl(url) + '" alt="' + escapeHtml(file.name) + '">');
    onEditingInput();
  } catch (err) {
    showFailure(err.message);
  }
});

el("attach-file-input").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const { filename, url } = await uploadFile(file);
    el("wysiwyg-editor").focus();
    document.execCommand("insertHTML", false, '<a href="' + sanitizeUrl(url) + '">' + escapeHtml(filename) + "</a>");
    onEditingInput();
  } catch (err) {
    showFailure(err.message);
  }
});

// ---------- undo / redo ----------
// A plain contenteditable's undo stack is native, browser-managed -
// no synthetic keyboard events or workarounds needed, unlike the
// ProseMirror-based editor this app used previously.
el("undo-btn").addEventListener("click", () => {
  const target = mode === "raw" ? el("raw-textarea") : el("wysiwyg-editor");
  target.focus();
  document.execCommand("undo");
});
el("redo-btn").addEventListener("click", () => {
  const target = mode === "raw" ? el("raw-textarea") : el("wysiwyg-editor");
  target.focus();
  document.execCommand("redo");
});

// Flash the editor's edge in the highlight colour, then let it fade.
// Restarting the animation needs the class off for one frame.
function showSaved() {
  const pane = document.querySelector(".editor-pane");
  if (!pane) return;
  pane.classList.remove("just-saved");
  void pane.offsetWidth;
  pane.classList.add("just-saved");
}

function scheduleSave() {
  el("save-indicator").textContent = "";
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNote, 500);
}

// Runs a pending debounced save NOW instead of in up-to-500ms. Must be
// awaited before anything that repoints the editor at a different note
// (opening another note, logging out) - otherwise the timer fires after
// the switch, reads the new note's state, and the old note's last edits
// are silently dropped.
async function flushPendingSave() {
  if (!savePending) return;
  await saveNote();
}

async function saveNote() {
  clearTimeout(saveTimer);
  savePending = false;
  if (!originalTitle) return;
  const newTitle = el("title-input").value.trim() || originalTitle;
  const content = currentMarkdown();

  try {
    const body = { content };
    if (newTitle !== originalTitle) body.new_title = newTitle;
    const result = await apiJson(`/notes/${encodeURIComponent(originalTitle)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const renamed = result.title !== originalTitle;
    originalTitle = result.title;
    currentTitle = result.title;
    el("save-indicator").textContent = "";
    showSaved();
    // Only re-fetch the sidebar when the title actually changed.
    // Saving the text of the note you already have open can't reorder
    // anything - it's pinned or recently-viewed either way - and doing
    // it on every pause in typing meant a directory scan on the server
    // plus a full sidebar rebuild every few seconds while writing.
    if (renamed) await loadNotes();
  } catch (e) {
    el("save-indicator").textContent = "error: " + e.message;
  }
}

// Last-resort flush when the tab is closed or backgrounded with a save
// still pending. An awaited fetch can't complete during unload, so this
// sends the PUT with keepalive, which the browser finishes after the
// page is gone. pagehide also fires when a mobile browser backgrounds
// the PWA, which is exactly when an unflushed edit would otherwise sit
// unsaved indefinitely.
window.addEventListener("pagehide", () => {
  if (!savePending || !originalTitle) return;
  const newTitle = el("title-input").value.trim() || originalTitle;
  const body = { content: currentMarkdown() };
  if (newTitle !== originalTitle) body.new_title = newTitle;
  fetch(`/api/notes/${encodeURIComponent(originalTitle)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  });
});

const DELETE_ICON = el("delete-btn").innerHTML;
let deleteConfirming = false;
let deleteConfirmTimeout = null;

function resetDeleteButton() {
  deleteConfirming = false;
  clearTimeout(deleteConfirmTimeout);
  el("delete-btn").innerHTML = DELETE_ICON;
  el("delete-btn").classList.remove("confirming");
}

document.addEventListener("click", (e) => {
  if (deleteConfirming && !el("delete-btn").contains(e.target)) resetDeleteButton();
});

el("delete-btn").addEventListener("click", async (e) => {
  if (!currentTitle) return;

  if (!deleteConfirming) {
    e.stopPropagation();
    deleteConfirming = true;
    el("delete-btn").textContent = "Confirm";
    el("delete-btn").classList.add("confirming");
    clearTimeout(deleteConfirmTimeout);
    deleteConfirmTimeout = setTimeout(resetDeleteButton, 4000);
    return;
  }

  resetDeleteButton();
  await apiJson(`/notes/${encodeURIComponent(currentTitle)}`, { method: "DELETE" });
  currentTitle = null;
  originalTitle = null;
  el("editor").hidden = true;
  await loadNotes();
});

// ---------- mode toggle ----------
el("mode-wysiwyg").addEventListener("click", () => switchMode("wysiwyg"));
el("mode-raw").addEventListener("click", () => switchMode("raw"));

function switchMode(next) {
  if (next === mode) return;
  const markdown = currentMarkdown();
  mode = next;

  el("mode-wysiwyg").classList.toggle("active", mode === "wysiwyg");
  el("mode-raw").classList.toggle("active", mode === "raw");
  el("wysiwyg-editor").hidden = mode !== "wysiwyg";
  el("format-bar").hidden = mode !== "wysiwyg";
  el("raw-textarea").hidden = mode !== "raw";

  if (mode === "raw") {
    el("raw-textarea").value = markdown;
  } else {
    el("wysiwyg-editor").innerHTML = mdToHtml(markdown);
    ensureTrailingParagraphAfterCodeBlock();
  }
}

// ---------- startup ----------
(async function init() {
  let status;
  try {
    status = await apiJson("/session");
  } catch (err) {
    showLogin();
    return;
  }
  // The server reports its own version (from Cargo.toml at compile
  // time), so the sidebar footer always shows which build is running.
  if (status.version) {
    el("version-link").textContent = "v" + status.version;
  }
  if (status.logged_in) {
    showApp();
    try {
      await loadNotes();
    } catch (err) {
      console.error("Failed to load notes on page load:", err);
      showFailure("Logged in, but your notes would not load: " + err.message);
    }
    return;
  }
  showLogin();
})();

// Labels on pointing. The browser's own tooltip sits too long and looks
// nothing like the rest, so the title attributes come off and this draws
// a small pill instead: in after 400ms, out after 1.5 seconds whether or
// not the pointer is still there. The full name stays in aria-label, so
// a screen reader loses nothing.
(function () {
  var node = null, inTimer = null, outTimer = null;

  function hide() {
    clearTimeout(inTimer); clearTimeout(outTimer);
    if (node) { node.remove(); node = null; }
  }

  function show(btn) {
    var text = btn.getAttribute("aria-label") || btn.dataset.label;
    if (!text) return;
    hide();
    node = document.createElement("span");
    node.className = "hover-label";
    node.textContent = text;
    document.body.appendChild(node);
    var b = btn.getBoundingClientRect(), l = node.getBoundingClientRect();
    var x = b.left + b.width / 2 - l.width / 2;
    // Near an edge it moves to whichever side fits rather than hanging off.
    x = Math.max(6, Math.min(x, window.innerWidth - l.width - 6));
    var y = b.bottom + 6;
    if (y + l.height > window.innerHeight - 6) y = b.top - l.height - 6;
    node.style.left = x + "px";
    node.style.top = y + "px";
    outTimer = setTimeout(hide, 1500);
  }

  function arm(e) {
    var btn = e.target.closest("[aria-label], [data-label]");
    if (!btn || !btn.matches("button, a, [role=button]")) return;
    clearTimeout(inTimer);
    inTimer = setTimeout(function () { show(btn); }, 400);
  }

  document.addEventListener("mouseover", arm);
  document.addEventListener("mouseout", function (e) {
    if (e.target.closest("[aria-label], [data-label]")) hide();
  });
  document.addEventListener("mousedown", hide);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
})();

// A small panel that asks for one or two values, in place of the
// browser's prompt box. It floats under the button that opened it,
// closes on Escape or on a click elsewhere, and hands back the answers.
// The editor's selection is put back before anything is inserted,
// because moving focus to a field throws it away.
function askFields(fields, anchor) {
  return new Promise((resolve) => {
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;

    const panel = document.createElement("div");
    panel.className = "ask-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", fields[0].label);

    const inputs = fields.map((f) => {
      const wrap = document.createElement("label");
      wrap.className = "ask-field";
      const name = document.createElement("span");
      name.textContent = f.label;
      const input = document.createElement("input");
      input.type = f.type || "text";
      input.value = f.value || "";
      if (f.min) input.min = f.min;
      if (f.max) input.max = f.max;
      wrap.append(name, input);
      panel.appendChild(wrap);
      return input;
    });

    const go = document.createElement("button");
    go.type = "button";
    go.className = "ask-go";
    go.textContent = "Insert";
    panel.appendChild(go);
    document.body.appendChild(panel);

    const b = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(b.left, window.innerWidth - p.width - 8)) + "px";
    panel.style.top = (b.bottom + 6 + p.height > window.innerHeight
      ? b.top - p.height - 6 : b.bottom + 6) + "px";

    inputs[0].focus();
    inputs[0].select();

    let done = false;
    function finish(values) {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onOutside, true);
      panel.remove();
      if (values && saved) {
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(saved);
      }
      resolve(values);
    }
    function submit() { finish(inputs.map((i) => i.value)); }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); finish(null); }
      else if (e.key === "Enter" && panel.contains(e.target)) { e.preventDefault(); submit(); }
    }
    function onOutside(e) { if (!panel.contains(e.target)) finish(null); }

    go.addEventListener("click", submit);
    document.addEventListener("keydown", onKey, true);
    // A beat, so the click that opened the panel does not close it again.
    setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
  });
}

// Failures show as red words under the toolbar, never as a browser
// pop-up. They stay until the next thing that works.
function showFailure(message) {
  const box = el("app-error");
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

function clearFailure() {
  const box = el("app-error");
  if (box) { box.textContent = ""; box.hidden = true; }
}
