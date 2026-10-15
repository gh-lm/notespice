#!/usr/bin/env python3
"""Builds the website's long document pages from the markdown in the repo.

The documentation, changelog, security policy and licence are kept as
markdown files because that is where they belong for anyone reading the
source. The website needs the same words as HTML, so this script converts
them and drops them into the same shell as the legal pages, taking that
shell from privacy.html so the header and footers can never drift apart.

Run it from the repository root:  python3 tools/build_pages.py
"""

import hashlib
import html
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
TARBALL = SITE / "notespice-source.tar.gz"
TODAY = "2026-10-05"

# Links that pointed at a file in the repo have to point at the page that
# now carries that file's words.
LINK_MAP = {
    "./CHANGELOG.md": "/changelog",
    "./SECURITY.md": "/security",
    "./README.md": "/docs",
    "./LICENSE": "/licence",
}


def esc(text):
    return html.escape(text, quote=False)


def inline(text):
    """Links, code spans, emphasis and bare autolinks.

    Links come out first so that a label containing a code span still becomes
    a link, and both are parked as placeholders so that escaping the plain
    text afterwards cannot touch the markup already built.
    """
    parts = []

    def stash(markup):
        parts.append(markup)
        return "\x00%d\x00" % (len(parts) - 1)

    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)",
                  lambda m: stash(_link(m.group(2), inline(m.group(1)))), text)
    text = re.sub(r"`([^`]+)`",
                  lambda m: stash("<code>%s</code>" % esc(m.group(1))), text)
    text = esc(text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![*\w])\*([^*\s][^*]*)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"&lt;(https?://localhost[^&\s]*)&gt;",
                  lambda m: stash("<code>%s</code>" % m.group(1)), text)
    text = re.sub(r"&lt;(https?://[^&\s]+)&gt;",
                  lambda m: stash(_link(m.group(1), m.group(1))), text)
    text = re.sub(r"&lt;([^@&\s]+@[^&\s]+)&gt;",
                  lambda m: stash('<a href="mailto:%s">%s</a>'
                                  % (m.group(1), m.group(1))), text)
    return re.sub(r"\x00(\d+)\x00", lambda m: parts[int(m.group(1))], text)


def _link(href, label):
    href = LINK_MAP.get(href, href)
    if href.startswith(("http://", "https://")) and "notespice.org" not in href:
        bare = re.sub(r"</?[^>]+>", "", label)
        return ('<a href="%s" target="_blank" rel="noopener noreferrer" '
                'aria-label="%s (opens in a new tab)">%s</a>'
                % (href, html.escape(bare, quote=True), label))
    return '<a href="%s">%s</a>' % (href, label)


def slug_of(text):
    """The same shape of anchor the markdown files already link to."""
    bare = re.sub(r"<[^>]+>", "", text).lower()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", bare)).strip("-")


def convert(md, releases=False):
    """Markdown to the handful of HTML blocks the stylesheet knows about."""
    lines = md.split("\n")
    out = []
    i = 0
    open_list = None          # 'ul' or 'ol' while one is being built
    next_number = 1           # so an interrupted numbered list carries on
    in_release = False

    def close_list():
        nonlocal open_list
        if open_list:
            out.append("</%s>" % open_list)
            open_list = None

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            close_list()
            i += 1
            continue

        # Fenced code.
        if stripped.startswith("```"):
            close_list()
            i += 1
            body = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                body.append(lines[i])
                i += 1
            i += 1
            while body and not body[0].strip():
                body.pop(0)
            pad = min((len(x) - len(x.lstrip()) for x in body if x.strip()),
                      default=0)
            out.append("<pre><code>%s</code></pre>"
                       % esc("\n".join(x[pad:] for x in body)))
            continue

        # Headings. The h1 is dropped: the page template writes its own.
        m = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if m:
            close_list()
            next_number = 1
            level = len(m.group(1))
            if level == 1:
                i += 1
                continue
            if releases and level == 2:
                if in_release:
                    out.append("</div>")
                out.append('<div class="release">')
                in_release = True
            text = inline(m.group(2))
            out.append('<h%d id="%s">%s</h%d>'
                       % (level, slug_of(text), text, level))
            i += 1
            continue

        # Quoted notes.
        if stripped.startswith(">"):
            close_list()
            body = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                body.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            out.append("<blockquote><p>%s</p></blockquote>"
                       % inline(" ".join(x.strip() for x in body if x.strip())))
            continue

        # Tables.
        if stripped.startswith("|"):
            close_list()
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            head, body = rows[0], rows[1:]
            if body and all(set(c) <= set("-: ") for c in body[0]):
                body = body[1:]
            out.append('<div class="table-wrap"><table><thead><tr>%s</tr></thead><tbody>'
                       % "".join("<th>%s</th>" % inline(c) for c in head))
            for row in body:
                out.append("<tr>%s</tr>"
                           % "".join("<td>%s</td>" % inline(c) for c in row))
            out.append("</tbody></table></div>")
            continue

        # List items, with their wrapped continuation lines.
        m = re.match(r"^(\s*)([-*]|\d+\.)\s+(.*)$", line)
        if m:
            indent, marker, text = m.group(1), m.group(2), m.group(3)
            kind = "ul" if marker in "-*" else "ol"
            i += 1
            while (i < len(lines) and lines[i].strip()
                   and not re.match(r"^\s*([-*]|\d+\.)\s+", lines[i])
                   and not lines[i].strip().startswith(("#", ">", "|", "```"))
                   and lines[i].startswith(" ")):
                text += " " + lines[i].strip()
                i += 1
            if open_list != kind:
                close_list()
                if kind == "ol":
                    out.append('<ol start="%d">' % next_number if next_number > 1
                               else "<ol>")
                else:
                    out.append("<ul>")
                open_list = kind
            if kind == "ol":
                next_number = int(marker.rstrip(".")) + 1
            cls = ' class="sub"' if indent else ""
            out.append("<li%s>%s</li>" % (cls, inline(text)))
            continue

        # An image on a line of its own: the page has its own branding.
        if re.fullmatch(r"!\[[^\]]*\]\([^)]*\)", stripped):
            i += 1
            continue

        # Everything else is a paragraph, joined to its wrapped lines.
        close_list()
        body = [stripped]
        i += 1
        while (i < len(lines) and lines[i].strip()
               and not re.match(r"^\s*([-*]|\d+\.)\s+", lines[i])
               and not lines[i].strip().startswith(("#", ">", "|", "```"))):
            body.append(lines[i].strip())
            i += 1
        out.append("<p>%s</p>" % inline(" ".join(body)))

    close_list()
    if in_release:
        out.append("</div>")
    return "\n".join(out)


# ---------------------------------------------------------------- the shell

MARKER = '<main id="main"><div class="panel">'
MODEL = SITE / "privacy.html"
MODEL_TITLE = "Privacy | Notespice"
MODEL_DESC = ("What this website records about you, which is almost nothing, "
              "and how to ask about it.")
MODEL_URL = "https://notespice.org/privacy"
MODEL_DATE = '"dateModified": "2026-09-06"'


def shell():
    text = MODEL.read_text()
    assert MARKER in text, "privacy.html no longer has the panel marker"
    head, rest = text.split(MARKER, 1)
    tail = "</div></main>" + rest.split("</div></main>", 1)[1]
    return head + MARKER + "\n", tail


def page(slug, title, desc, heading, lead, body, head_tmpl, tail):
    head = (head_tmpl
            .replace(MODEL_TITLE, "%s | Notespice" % title)
            .replace(MODEL_DESC, desc)
            .replace(MODEL_URL, "https://notespice.org/" + slug)
            .replace(MODEL_DATE, '"dateModified": "%s"' % TODAY))
    for leftover in ("Privacy | Notespice", "/privacy", MODEL_DESC):
        assert leftover not in head, "the shell still mentions %r" % leftover
    middle = "<h1>%s</h1>\n<p class=\"updated\">%s</p>\n\n%s\n" % (
        heading, lead, body)
    return head + middle + tail


# --------------------------------------------------------------- the source

def build_tarball():
    """The application source, as a download, because the image is GPL.

    The website's own pages are left out: they are not part of the program,
    and leaving them out means this archive does not have to contain the
    page that quotes its own checksum.
    """
    listed = subprocess.run(["git", "ls-files"], cwd=ROOT, check=True,
                            capture_output=True, text=True).stdout.split()
    keep = [f for f in listed
            if not f.startswith(("site/", ".claude/"))
            and f != "charlie-tasks.md"]
    assert len(keep) > 20, "only %d files to pack, something is wrong" % len(keep)
    listing = ROOT / "tools" / ".sourcelist"
    listing.write_text("\n".join(keep) + "\n")
    subprocess.run(["tar", "czf", str(TARBALL), "--transform", "s,^,notespice/,",
                    "--owner=0", "--group=0", "--mtime=" + TODAY,
                    "--sort=name", "-T", str(listing)], cwd=ROOT, check=True)
    listing.unlink()
    data = TARBALL.read_bytes()
    return len(keep), len(data), hashlib.sha256(data).hexdigest()


def source_body(files, size, digest):
    return """\
<h2>Download</h2>
<p>Notespice is free software under the GNU General Public Licence, version 3
or later. Anyone who is given the program is entitled to its source, so here
it is, as one archive.</p>
<p><a class="dl" href="/notespice-source.tar.gz" download>notespice-source.tar.gz</a>
<span class="muted">%(kb)d KB, %(files)d files</span></p>
<p>Check it against this before you trust it:</p>
<pre><code>sha256  %(digest)s</code></pre>
<p>This archive is the program: the Rust server, the browser frontend, the
Dockerfile, the build files and the documentation. The pages of this website
are not part of the program and are not in it.</p>

<h2>Building it yourself</h2>
<p>You need a Rust toolchain, which you can get from
<a href="https://rustup.rs">rustup</a>, or Docker if you would rather build the
image.</p>
<pre><code>tar xzf notespice-source.tar.gz
cd notespice
cargo build --release</code></pre>
<p>The binary lands in <code>target/release/notespice</code>. To build the
container image instead:</p>
<pre><code>docker build -t notespice .</code></pre>
<p>The full instructions, including every setting, are on the
<a href="/docs">documentation page</a>.</p>

<h2>The ready-made image</h2>
<p>If you only want to run Notespice rather than build it, the image is
published on GitHub's registry as
<code>ghcr.io/gh-lm/notespice</code>.</p>

<h2>Browsing the code instead</h2>
<p>The archive above is the whole source, and it is replaced whenever a new
version is released, so it always matches the current image. If you would
rather read it in a browser, the same code is at
<a href="https://github.com/gh-lm/notespice" target="_blank" rel="noopener noreferrer">github.com/gh-lm/notespice</a>.
The <a href="/changelog">changelog</a> records what changed in each
release.</p>
""" % {"kb": round(size / 1024), "files": files, "digest": digest}


LICENCE_LEAD = """\
<p>Notespice is free software. You may use it, read it, change it and pass it
on, under the terms of version 3 of the GNU General Public Licence, or any
later version. There is no warranty.</p>
<p>The <a href="/source">source page</a> has the code, and the
<a href="https://www.gnu.org/licenses/quick-guide-gplv3.html">Free Software
Foundation's short guide</a> explains the licence in plain words. The full
text follows.</p>
"""



def stamp_css():
    """Put a content hash on the stylesheet link.

    The host tells browsers to keep anything under /styles for a week, so
    without this a visitor who saw the old site keeps the old styling for
    up to seven days. The hash changes whenever the file changes, which
    makes the address new and the old copy irrelevant.
    """
    css = SITE / "styles" / "legal.css"
    digest = hashlib.sha256(css.read_bytes()).hexdigest()[:8]
    pages = sorted(SITE.glob("*.html")) + sorted(
        (ROOT / ".publish" / "site").glob("*.html"))
    changed = 0
    for page in pages:
        text = page.read_text()
        new = re.sub(r'(href="/styles/legal\.css)(\?v=[0-9a-f]+)?"',
                     r'\g<1>?v=%s"' % digest, text)
        if new != text:
            page.write_text(new)
            changed += 1
    print("css stamp %s, %d page(s) updated" % (digest, changed))


REDIRECTS = [
    # Addresses that used to live on other hosts, and one American
    # spelling. Cloudflare Pages served these from a _redirects file;
    # GitHub Pages has no such thing, so each one is a small page that
    # sends the browser on and names the real address as canonical.
    ("code", "/source"),
    ("whats-new", "/changelog"),
    ("bugs", "/security"),
    ("license", "/licence"),
]

REDIRECT_PAGE = """<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Moved</title>
<link rel="canonical" href="https://notespice.org%(target)s" />
<meta http-equiv="refresh" content="0; url=%(target)s" />
<meta name="robots" content="noindex" />
<style>body{background:#1c1e26;color:#fafafa;font-family:system-ui,sans-serif;
margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
a{color:#fbc711}</style>
</head>
<body><p>This page is now at <a href="%(target)s">notespice.org%(target)s</a>.</p></body>
</html>
"""


def build_redirects():
    """One small page per old address, because GitHub Pages cannot do
    server-side redirects. Written as <path>/index.html so the old
    address keeps working with or without a trailing slash."""
    for path, target in REDIRECTS:
        out = SITE / path
        out.mkdir(parents=True, exist_ok=True)
        (out / "index.html").write_text(REDIRECT_PAGE % {"target": target})
    print("redirects %6d page(s)" % len(REDIRECTS))


def without_pictures(md):
    """The README leads with a banner, screenshots and a diagram. They are
    there for anyone reading the repository; the website has its own
    pictures, so the documentation page takes the words alone."""
    md = re.sub(r"<p align=\"center\">.*?</p>\s*", "", md, flags=re.S)
    md = re.sub(r"<table>.*?</table>\s*", "", md, flags=re.S)
    return md


def main():
    head_tmpl, tail = shell()
    files, size, digest = build_tarball()

    pages = [
        ("docs", "Documentation", "How to run Notespice, every setting it has, "
         "and how it keeps your notes.", "Documentation",
         "Everything about running Notespice, from first start to every setting.",
         convert(without_pictures((ROOT / "README.md").read_text()))),
        ("changelog", "Changelog", "Every release of Notespice and what changed "
         "in it, newest first.", "Changelog",
         "Every release, newest first.",
         convert((ROOT / "CHANGELOG.md").read_text(), releases=True)),
        ("security", "Security", "How to report a security problem in Notespice, "
         "and what to expect when you do.", "Security",
         "How to report a security problem, and what happens next.",
         convert((ROOT / "SECURITY.md").read_text())),
        ("licence", "Licence", "Notespice is free software under version 3 of "
         "the GNU General Public Licence.", "Licence",
         "Notespice is free software under the GNU General Public Licence.",
         LICENCE_LEAD + '<pre class="licence-text"><code>'
         + esc((ROOT / "LICENSE").read_text().rstrip()) + "</code></pre>"),
        ("source", "Source", "Download the full source of Notespice and build "
         "it yourself.", "Source",
         "The code, and what to do with it.",
         source_body(files, size, digest)),
    ]

    for slug, title, desc, heading, lead, body in pages:
        out = page(slug, title, desc, heading, lead, body, head_tmpl, tail)
        (SITE / (slug + ".html")).write_text(out)
        twin = ROOT / ".publish" / "site" / (slug + ".html")
        if twin.parent.is_dir():
            twin.write_text(re.sub(r"\n?[ \t]*<!--.*?-->", "", out, flags=re.S))
        print("%-10s %6d bytes" % (slug, len(out)))

    print("tarball   %6d bytes, %d files" % (size, files))
    build_redirects()
    stamp_css()
    print("sha256    %s" % digest)


if __name__ == "__main__":
    sys.exit(main())
