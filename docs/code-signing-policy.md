# Code signing policy

Typose 0.1.0 is not code-signed. Typose's Windows releases are to be signed from 0.2.0 through SignPath Foundation's free code signing for open-source projects, once SignPath Foundation accepts the project. Until a release says it is signed, it isn't.

Signed releases will carry this line:

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)

## What is signed

Only Typose's own files: the Windows installer; `Typose.exe`, which is Electron's executable given Typose's name, version, and asar integrity; and Typose's core addon, built from this repository's Rust source. Each is built by GitHub Actions ([`release.yml`](../.github/workflows/release.yml)) from a tagged commit on `main`, after the full test suite passes on that commit, and each signing request is approved by hand. Third-party binaries that ship inside the installer, such as Electron's and Chromium's, are not signed by this project.

## Team roles

| Role | Who |
| --- | --- |
| Committers and reviewers | [Zack Meacham](https://github.com/zackmeach) |
| Approvers | [Zack Meacham](https://github.com/zackmeach) |

Changes reach `main` through pull requests, and a pull request merges only once CI passes on Windows, Linux, and macOS. Everyone with a role here uses multi-factor authentication on GitHub and on SignPath.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

Typose reads local files and makes no network requests. A web or email link opens in your browser or mail app only when you choose to open it.
