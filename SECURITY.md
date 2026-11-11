# Security

## Reporting a vulnerability

Use GitHub's private reporting: open the Security tab of this repository and choose **Report a vulnerability**. Do not open a public issue for a vulnerability.

## What is in scope

Typose treats every file it opens as untrusted. Anything an opened file can make Typose do that it should not is in scope:

- Run script.
- Reach the network.
- Read or write outside what the user opened.
- Crash the core repeatedly.

## What Typose promises

- It makes no network requests. Every request except the app's own `typose:` scheme, `data:` and `blob:` is cancelled, and an end-to-end test reads a NetLog to check that nothing leaves the machine.
- It opens files read-only.
- It sanitizes raw HTML in Markdown in the Rust core, against an allowlist of tags and attributes.
- Crash reports stay on the machine.
- It has no auto-update.

## Supported versions

There are no releases yet, so only `main` is supported.
