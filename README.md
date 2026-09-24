# dsh-session-delete

Adds a **Delete session** action to the DeepSeek Harness Web UI, and bundles the session-log
download into the same header "⋯" menu — one tidy menu instead of two separate buttons.

This is a **DSH profile plugin**, not a standalone app: it hooks the Harness plugin surface and
only runs inside the DeepSeek Harness web runtime.

## Install

**Requirements** — the DeepSeek Harness web runtime (tested against
`@deepseek-ai/dsh@0.1.6-alpha.x`). The bundled download item re-drives the shipped
`@deepseek-ai/dsh-session-log-export`; without that plugin the menu degrades to **Delete only**.

**From npm** — not currently published: the name `dsh-session-delete` is already taken on the
npm registry (by an unrelated package), so no scoped release exists yet. Install from git or the
bundled profile below.

**From git** — `github:sambashir01/dsh-session-delete#v0.1.1`.

Install through the Harness **Plugins** page, the CLI (`dsh plugin --profile <name> add
<spec>`), or from an agent session with `plugin_manager install_bundle <spec>`.

**During development (local directory)** — install the bundle from its own directory with
`plugin_manager install_bundle` (target = the package directory). Bundles are profile-scoped:
they affect every session in the profile and survive restart.

> The browser half loads its client-kit modules (`@deepseek-ai/dsh-client-store`,
> `dsh-client-ui-primitives`, `react`, …) from the DSH runtime at page load — **do not**
> `npm install` client dependencies for this bundle. Same contract as the shipped
> `@deepseek-ai/dsh-session-log-export` bundle.

## Usage

Open a conversation → header **⋯** → **Download session log** | **Delete session**.

- **Download session log** re-drives DSH's own export service. The shipped standalone button
  is shadowed, so you always see exactly one ⋯ carrying both items.
- **Delete session** opens a risk dialogue that must be acknowledged (this is permanent). On
  confirm the plugin navigates away, calls `POST /api/session.delete`, and removes:
  - the session directory and its whole sub-session lineage
    (`${DSH_HOME}/sessions/<project>/<encoded-id>`),
  - workspace rows and the archive marker for **every** deleted id (root + descendants), so no
    ghost rows remain.

## One combined ⋯ menu

The header action registers under the shipped slot `conversation.session.header.utilities`
with id `session-log-download` at `priority: -1`, shadowing the shipped "Download session log"
button (same id, lower priority ⇒ it renders). The log-export plugin stays mounted — our
download item re-drives its controller and reproduces its status dialog from that controller's
store. If the log-export plugin is absent, the download item hides and the menu degrades to
Delete only. Disabling this plugin restores the original button automatically.

## Safety model

- **Refuses while a turn is running** — an `Agent` with `status === "running"` on the session
  or any descendant blocks deletion (the host waits ~6 s for a just-finished turn to settle,
  then returns 409). It deliberately does **not** refuse merely because a session is resident
  in memory: the engine keeps resumed sessions resident for the host's lifetime, so a residency
  check would make every previously-opened session undeletable.
- **Provability before removal** — the JSONL backend's `projectKey`/`encodeSegment` path
  mapping is replicated exactly, then each directory is stat'ed, layout-checked (must contain
  `*.jsonl`/`*.jsonl.zstd` or `session.lock`), and resolved through any symlinks (a path that
  redirects outside the sessions root, or whose final component is itself a symlink, is refused)
  before anything is removed. A path that cannot be proven to be a session folder is refused,
  and any stat/readdir failure other than "already gone" aborts the delete (never false success).
- **Already-gone is fine** — a missing folder (never flushed, or already removed by an
  overlapping delete), or an id the backend no longer knows, is treated as deleted: the host
  returns success and the registries are cleaned, so deleting again is idempotent. Because the
  host answers success for unknown ids, a non-2xx response is always a real failure (a missing
  endpoint can never be mistaken for "done").
- **Attachments are untouched** — attachments live in a global content-addressed pool and are
  intentionally not freed by deletion.
- **Auth** — the route rides the same browser-session connection auth as session export and
  workspace delete.

## Trade-offs

- Deleting the open session navigates away first (the host cannot dispose an open session it
  does not own); on failure it is best-effort reopened so the error shows in its own header
  dialog. If you navigate elsewhere yourself during the ~6 s waiting window, the failure path
  will still return you to the session being deleted — accepted, because it is the only place
  its error dialog can render.
- After a delete the folder and registry rows are gone, but the engine's in-memory session /
  agent store entry (if any) persists until the DSH host restarts — the plugin cannot dispose
  engine-owned objects. It is detached from the UI and a repeat delete reports "already gone";
  the only residual risk is a live writer touching the resident entry after deletion, which the
  running-guard blocks while a turn is running.
- The workspace sidebar can briefly show a ghost row for the deleted session until the next
  re-index; it is inert (opening reports "not found") and a repeat delete stays idempotent.
- SQLite session-query rows are reconciled from disk by the engine; this plugin performs no
  FTS cleanup.

## Testing

Run the suite with `npm test` (Node ≥ 22 for `node --test`). Ships no dependencies; nothing
touches a real DSH_HOME or a real service.

Three files under `test/`:

- **`host.test.mjs`** — the host `POST /api/session.delete` route, driven with fake services
  and a scratch session root under `os.tmpdir()`: happy path deletes a session dir plus its
  whole sub-session lineage and cleans workspace/archive rows; already-gone is idempotent
  success; running-turns (409) and a missing agents runtime (503) refuse without removing
  anything; non-session folders and symlinked paths are refused (409); a throwing
  `workspaceRegistry.list()` can never turn success into error; malformed / missing / invalid
  `sessionId` are 400; orphaned subtrees (parent header absent) still delete; and a failed
  removal aborts **before** the session dir itself is removed so a retry finds everything
  (exercised on macOS with `chflags uchg`, auto-skipped elsewhere).
- **`drift.test.mjs`** — pins the replicated `projectKey`/`encodeSegment` path encoding — the
  code that decides *which directory gets removed* — to a frozen snapshot of the real backend
  source (`test/fixtures/session-path-0.1.6-alpha.2.txt`), for both the shipped copies in
  `index.js` and the test-local copies in `test/path-map.mjs`, across a deterministic 2 000-case
  fuzz corpus plus fixed regression anchors. Any behavioral divergence here is a
  release-blocker: it means a delete targets the wrong directory.
- **`i18n.test.mjs`** — asserts the `zh`/`en` locale dictionaries expose exactly the same key
  set and that critical confirm / error / busy keys exist, so no locale ever silently loses a
  label.

> The drift fixture is a snapshot of module-private upstream source. **Regenerate it when the
> DSH JSONL backend changes** (see the fixture header), then confirm the fuzz still agrees — or
> the plugin must be updated to the new layout.

## Development

- Only `client.js` is served live from disk (page reload picks it up). Edits to `index.js`
  (host route/guard) are picked up only when the host process restarts.
- Tested end-to-end in the Harness web GUI on `@deepseek-ai/dsh@0.1.6-alpha.x`.

## License

MIT — see [LICENSE](LICENSE). Changelog in [CHANGELOG.md](CHANGELOG.md).
