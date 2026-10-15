# Headers the edge has to send

GitHub Pages cannot send custom response headers, and it ignores a
`_headers` file. notespice.org is served by GitHub Pages behind
Cloudflare as a proxy, so these headers are set at the Cloudflare edge
instead, as a response header transform rule on the zone.

This file exists so the list is not lost. It used to live in
`site/_headers`, which Cloudflare Pages read directly; that file is gone
because the current host would serve it as a page.

## On every response

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |

## Caching

| Path | `Cache-Control` |
|---|---|
| `/fonts/*` | `public, max-age=31536000, immutable` |
| `/images/*` | `public, max-age=31536000, immutable` |
| `/styles/*` | `public, max-age=604800` |

Without these, GitHub Pages serves its own `max-age=600` and the 485KB
typeface is refetched far more often than it needs to be.

## Not set here

The `Content-Security-Policy` and the referrer policy are `<meta>` tags
inside each page, not headers, because the home page and the legal pages
need different policies and one header would flatten both. Leave them
where they are; do not add a CSP header at the edge, or it will override
the per-page ones.

`frame-ancestors` is deliberately absent from the meta policies. Browsers
ignore that directive in a `<meta>` tag, so `X-Frame-Options` above is
what actually stops the site being framed. If the proxy is ever taken
away, that protection goes with it.
