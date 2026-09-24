# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-23

### Added

- **Delete session** action in the conversation header "⋯" menu, gated behind a
  tick-to-confirm risk dialogue. Permanently removes the session and its whole
  sub-session subtree (safe-delete never touches folders it cannot prove are
  sessions; refuses while a turn is running; cleans the session out of workspaces
  and the archive).
- **Download session log** bundled into the same header menu, re-driving the app's
  own log-export service so one tidy menu replaces two separate buttons. When the
  plugin is disabled, the app's original button is restored automatically.
- Authenticated `POST /api/session.delete` endpoint with a running-guard (409 while
  a turn is active), the same trust model as the app's own session-export endpoint.
- Published under MIT with install docs; works only inside the DeepSeek Harness web
  runtime.

### Security & robustness (host)

- Cycle-safe lineage walk; missing folders are treated as already-gone instead of
  failing the delete; running-guard re-checked immediately before removal; internal
  paths never leak in error responses (logged server-side instead).
