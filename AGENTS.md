# Working in this repository

Standing rules for any agent session here. This file is their one home: change a rule here, in a commit.

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the checks, the flaky-test rule and the quiet-machine tests. [`docs/release-checklist.md`](docs/release-checklist.md) has the release steps. This file does not repeat them.

1. **No network.** Nothing in the app touches the network, update checks included. The NetLog gate stays.
2. **Merge bar.** CI on Windows, Ubuntu and macOS: every required check (13 today) green on the exact head, read from the checks API.
   - A retry is evidence, not a pass: a test that fails and then passes still fails its job.
   - A dispatched run does not stand in for the pull request's own run.
   - A wall-clock bound that only a hosted runner misses is skipped there with `quiet()` (`e2e/app.ts`), and the rest of its test still runs. `core/typose-core/tests/ledger.rs` is deterministic and stays in CI.
   - macOS stays in the gate. CONTRIBUTING says when a macOS job that no runner picked up may be merged past; one that ran and failed never qualifies.
3. **Review depth.** Full-depth review for security work (capabilities, hand-off and external-URL checks, the network guard and CSP, IPC, the sanitizer), for memory and ledger work, and for data-loss paths (session save, close capture); one round otherwise. Full depth means at least one executed adversarial review, posted on the PR, that covers the PR's last own commit. Read-only reviews do not add up to one.
   - A merge of `main` after that review, or a rebase onto it, needs a fresh review only if it changes a file the PR also changes, or a file in one of the areas above.
   - A merge with conflict resolutions or hand edits is an own commit. The files a PR changes are its diff against `main` at the head that merges.
4. **Refactors ride with features.** Every limit states itself in the UI.
5. **Synthetic fixtures only.** Research is never committed.
6. **Electron** stays within two majors of stable.
7. **Linux is best-effort.** Ubuntu CI blocks merges like the others, but an accessibility or frame test that fails only on Ubuntu is skipped there with its reason. There is no manual qualification on Linux.
8. **Dependencies stay pinned exactly.** Refreshes are tiered by where the code runs:
   - build and test tools merge on green checks plus a lockfile read;
   - shipped code that never reads file contents adds the upstream change list;
   - anything that reads document or third-party bytes (parser, sanitizer, decoders, Electron, KaTeX, Mermaid, Shiki, theme parsing, DOMPurify, the vendored crates) gets an executed review.

   A crate whose memory a derived constant charges has that constant re-derived on every refresh. Any advisory in the lock stops the line: cargo-deny turns every PR red until it is dealt with.
9. **Who decides.** The orchestrating session merges without asking when rule 2 holds and the reviews rules 3 and 8 require are posted. Major dependency bumps, changes to a security rule and striking one of the design brief's promises wait for the maintainer. Reports go out at merges and decisions. At most two work streams run at once; a helper session retires when its PRs land, and each phase starts fresh helpers from a written brief. A `vX.Y.Z` tag is pushed only when the maintainer says so.
10. **Build before you launch.** Before any app or e2e launch, build what it needs and check that the script it loads exists: `app/out/main/index.js`, or `app/out-hooks/main/index.js` for a test-hooks launch and for `npm run perf`. A launch from an unbuilt tree leaves a blocking error dialog on the desktop.
11. **Recorded decisions are the record.** After a context compaction, read the maintainer's recorded decisions again before acting on one. Where they exist they are in `.evidence/decisions/` in the main checkout; a worktree has no copy.
