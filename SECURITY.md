# Security policy

Notespice is a single-maintainer project, not a company or a team with a
dedicated security function. This page sets realistic expectations
rather than promising something that is not true.

## Supported versions

Only the latest release is supported, which is the `latest` tag and the
most recent tagged commit. There is no long-term-support branch and no
backporting to older versions. If a vulnerability is found, the fix
lands in the next build and you are expected to update to it.

| Version | Supported |
|---|---|
| 1.0.0 | yes |
| 1.8.x and earlier | no |

## Reporting a vulnerability

**Please do not put the details of a security vulnerability in a public
issue.** A public report discloses the problem to everyone, including
anyone running an unpatched copy, before a fix exists.

Use GitHub's private vulnerability reporting on this repository, under
**Security**, then **Report a vulnerability**. It goes straight to the
maintainer and nobody else can see it.

If you would rather not use GitHub, write to
<complaints@lightmorphic.com> with "Notespice security" in the subject
line and say only that you have a security issue to report. Leave the
details out of that first message, and a private channel will be
arranged for the rest.

## What to expect

This is maintained in whatever time is available outside other
commitments, not against a service level agreement. Best effort, not
guaranteed:

- Acknowledgement of a report: a few days is the aim
- A fix or a mitigation: depends on severity and complexity. It could
  be same-day for something simple and serious, or longer for something
  subtle

## Scope

This policy covers the Notespice application itself: the Rust backend,
the frontend and the Dockerfile. It does not cover:

- Vulnerabilities in dependencies. Report those upstream, to the
  dependency's own maintainers or through [RustSec](https://rustsec.org/)
- Your own deployment: reverse proxy configuration, TLS setup, network
  exposure and host OS are outside this project's control

## What is already in place

So a report can focus on what is genuinely new, the
[Security section of the README](./README.md#security) lists what is
already built in: Argon2id password hashing, server-side session
tokens, per-IP login rate limiting, allow-list filename sanitisation
against path traversal, a non-root container user, OS packages patched
at every build, and capped request and import sizes.
