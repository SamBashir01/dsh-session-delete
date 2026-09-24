# dsh-session-delete

Adds a **Delete session** action to the DeepSeek Harness Web UI, and bundles the session-log
download into the same header "⋯" menu — one tidy menu instead of two separate buttons.

This is a **DSH profile plugin**, not a standalone app: it hooks the Harness plugin surface and
only runs inside the DeepSeek Harness web runtime.

## Install

**From npm** — `dsh-session-delete` (TBD, first published release).

**From git** — `github:sambashir001/dsh-session-delete#v0.1.0`.

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
  confirm the plugin navigates away, calls `POST /api/session.delete`, and permanently removes:
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
  mapping is replicated exactly, then each directory is stat'ed and layout-checked (must
  contain `*.jsonl`/`*.jsonl.zstd` or `session.lock`) before anything is removed. A path that
  cannot be proven to be a session folder is refused.
- **Already-gone is fine** — a missing folder (never flushed, or already removed by an
  overlapping delete) is treated as deleted and cleaned out of the registries; deleting again
  is idempotent and returns success. 404 is reserved for an unknown session id.
- **Attachments are untouched** — attachments live in a global content-addressed pool and are
  intentionally not freed by deletion.
- **Auth** — the route rides the same browser-session connection auth as session export and
  workspace delete.

## Trade-offs

- Deleting the open session navigates away first (the host cannot dispose an open session it
  does not own); on failure it is best-effort reopened so the error shows in its own header
  dialog.
- After a delete the folder and registry rows are gone, but the session's in-memory agent
  object (if any) lingers until host restart. It is inert: opening it reports "not found".
- SQLite session-query rows are reconciled from disk by the engine; this plugin performs no
  FTS cleanup.

## Development

- Only `client.js` is served live from disk (page reload picks it up). Edits to `index.js`
  (host route/guard) are picked up only when the host process restarts.
- Tested end-to-end in the Harness web GUI on `@deepseek-ai/dsh@0.1.6-alpha.x`.

## License

MIT — see [LICENSE](LICENSE). Changelog in [CHANGELOG.md](CHANGELOG.md).
