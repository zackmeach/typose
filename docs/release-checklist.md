# Release checklist

A release is a `vX.Y.Z` tag on `main`. Pushing it runs [`release.yml`](../.github/workflows/release.yml), which runs the same checks as a PR on the tagged commit and, only if they all pass, publishes a public pre-release with the Windows installer and zip. Only a maintainer pushes a release tag.

## Before the tag

1. **Version.** `app/package.json`'s `version`, and `packages.app.version` in `package-lock.json`, are the new version.
2. **Notes.** `CHANGELOG.md` has a `## X.Y.Z` entry with a `### Known issues` list. The release's notes are that entry, as it is.
3. **Green `main`.** The commit you will tag is on `main`, and its CI passed.
4. **Quiet-machine tests.** On a Windows PC with every other app stopped (browsers, editors, sync clients, other test runs), run each command in CONTRIBUTING's [Tests that need a quiet machine](../CONTRIBUTING.md#tests-that-need-a-quiet-machine). Every bound must pass; a failure blocks the release.
5. **Vendored crates.** `core/vendor/zune-jpeg` and `core/vendor/csv-core` are patched local copies, so an upstream fix never reaches them through a lockfile update. Each copy's `TYPOSE-PATCH.md` names its upstream version. Check for advisories and security fixes since that version:
   - [RustSec](https://rustsec.org/packages/zune-jpeg.html) and the GitHub advisories for [etemesi254/zune-image](https://github.com/etemesi254/zune-image/security/advisories), and its releases;
   - [RustSec](https://rustsec.org/packages/csv-core.html) and the GitHub advisories for [BurntSushi/rust-csv](https://github.com/BurntSushi/rust-csv/security/advisories), and its releases.

   Note what you checked, and when, in the release PR or the tag's message.
6. **Dry run.** Tag `main`'s head `dry-run/vX.Y.Z` and push it. `release.yml` runs every check and makes a draft pre-release instead of publishing. Download its installer for the next step.
7. **Hands-on Windows checks**, on the dry run's installer, on a real PC:
   - Install: SmartScreen shows "Unknown publisher" while the app is unsigned; **More info → Run anyway** installs it, with no administrator prompt.
   - Print a document with **Print…** (Ctrl+P) through the real Windows print dialog, to a printer or Microsoft Print to PDF.
   - Zoom at 125% and at 150% display scaling (**Settings → System → Display → Scale**): text stays sharp, and nothing is cut off or overlaps.
   - The caption buttons: minimize, maximize and restore, close, and the snap layouts that show on hovering maximize.
   - Drop a file, then a folder, from File Explorer onto the window.
   - With Typose open, open a second file from File Explorer through **Open with → Typose**: it opens in the running window.
   - Uninstall it from **Settings → Apps**: Typose leaves Open with.
8. Delete the dry run: `gh release delete dry-run/vX.Y.Z --yes --cleanup-tag`.

A release blocker is data loss, a security problem, an app that can't install or launch, a crash or a multi-second freeze on a supported file, or a quiet-machine bound that fails. Everything else goes in the entry's known issues.

## The tag

```powershell
git tag -a vX.Y.Z -m "Typose X.Y.Z"
git push origin vX.Y.Z
```

When `release.yml` finishes, check the release page: a pre-release, the two assets (`Typose-X.Y.Z-setup.exe` and `Typose-X.Y.Z-win-x64.zip`), and the notes.

If a check fails, nothing is published:

- If a job is red only for a flaky test that CONTRIBUTING's [flaky-test rule](../CONTRIBUTING.md#flaky-tests) says to re-run, use **Re-run failed jobs** on that release run. `publish` runs once they pass.
- For a real failure, fix it on `main`, delete the tag (`git push --delete origin vX.Y.Z`), and tag again.
