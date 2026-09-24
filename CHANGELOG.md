# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Test suite (`npm test` now runs 15 tests in three files):
  - `test/host.test.mjs` — sandboxed host-route tests against fake services and a scratch
    session root: happy-path lineage delete, idempotent already-gone, 409/503 guard failures,
    non-session-folder and symlink refusal, throwing-registry resilience, 400 validation,
    orphaned-subtree delete, and abort-before-root on failed removal (`chflags`, macOS-gated).
  - `test/drift.test.mjs` — pins the replicated `projectKey`/`encodeSegment` path encoding to
    a frozen snapshot of the JSONL backend source (`test/fixtures/`), fuzzed over a
    deterministic 2 000-case corpus for both the shipped and the test-local copies.
  - `test/i18n.test.mjs` — asserts `zh`/`en` locale dictionaries expose identical key sets and
    critical keys exist.
- README "Testing" section documenting how to run the suite and when to regenerate the drift
  fixture.

## [0.1.0] - 2026-09-24

### Added

- **Delete session** action in the conversation header "⋯" menu, gated behind a tick-to-confirm
  risk dialogue. Removes the session and its whole sub-session subtree: the on-disk session
  directory (never touching folders it cannot prove are sessions), the workspace rows and the
  archive marker for every deleted id.
- **Download session log** bundled into the same header menu, re-driving the app's own
  log-export service so one tidy menu replaces two separate buttons. When the plugin is
  disabled, the app's original button is restored automatically; when the log-export plugin is
  absent, the download item hides and the menu degrades to Delete only.
- Authenticated `POST /api/session.delete` endpoint with the same trust model (browser-session
  auth) as the app's own session-export endpoint.

### Fixed

- Cycle-safe lineage walk; missing folders and unknown ids are treated as already-gone instead
  of failing or erroring, so a repeat delete is idempotent and a non-2xx is always a real
  failure (never a missing endpoint disguised as success).
- Running-guard re-checked immediately before removal; the guard fails closed when the agent
  runtime is unavailable.
- Provability hardened against symlink swaps: paths are resolved canonically and must resolve
  to the encoded id inside the sessions root, and a final symlink component is refused.
- Stat/readdir failures other than "already gone" abort the delete instead of reporting false
  success; children are removed before the root so a partial failure leaves the folder
  discoverable for a retry (no unreachable orphans).
- Registry cleanup is one best-effort unit — a throwing `workspaceRegistry.list()` can no longer
  turn a successful delete into a 500 that contradicts the outcome.
- Browser: the download item's presence is gated on the actual controller (fixes the download
  item rendering and silently no-oping when the log-export plugin is absent); a still-busy
  session reports a localized "try again shortly" message instead of a raw HTTP 409; network
  errors no longer claim they know the session was not deleted.

### Security

- Internal paths never leak in error responses (logged server-side instead); deletion refuses
  without a working running-guard rather than proceeding ungated.
