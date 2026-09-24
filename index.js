import { stat, lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve, sep, basename } from "node:path";
import { homedir } from "node:os";

const name = "session-delete";
const inject = ["connection", "agents", "sessionPersistence", "workspaceRegistry"];

const DELETE_SESSION_PATH = "/api/session.delete";
// Settle/poll knobs. Overridable via env so the destructive-path tests run fast;
// production hosts keep the defaults (the tests clamp them to small values).
const SETTLE_MS = Number(process.env.DSH_SESSION_DELETE_SETTLE_MS) >= 1 ? Number(process.env.DSH_SESSION_DELETE_SETTLE_MS) : 6000;
const POLL_MS = Number(process.env.DSH_SESSION_DELETE_POLL_MS) >= 1 ? Number(process.env.DSH_SESSION_DELETE_POLL_MS) : 50;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,300}$/;

export { name, inject, apply };

// ---- Path mapping (REPLICATES the JSONL persistence backend) ----
// A session's on-disk folder is `<root>/<projectKey(cwd)>/<encodeSegment(id)>`.
// projectKey/encodeSegment are NOT exported by @deepseek-ai/dsh-session-persistence-jsonl
// (implementation lives in its lib/index.js, ~L875), so we re-implement the exact same
// algorithm here. Keep this byte-for-byte identical to the backend: any mismatch would
// make us stat/remove the wrong directory. Do not "clean up" or diverge from it.
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}

function projectKey(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

function projectDir(root, cwd) {
	if (cwd === void 0) return join(root, "_no-cwd");
	return join(root, projectKey(cwd));
}

function sessionDir(root, cwd, id) {
	return join(projectDir(root, cwd), encodeSegment(id));
}

function defaultRoot() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : homedir();
	return resolve(join(home, ".dsh", "sessions"));
}

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

// Runs a registry call but never lets a failing cleanup abort the delete.
async function bestEffort(fn) {
	try {
		await fn();
	} catch {
		// best-effort: registries are secondary to the file removal
	}
}

function jsonResponse(status, payload) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" }
	});
}

function connectionOf(ctx) {
	return Reflect.get(ctx, "connection");
}

// Lineage walk: sub-session children live as SEPARATE dirs under the same project key,
// linked by a `header.parentSession` field. Deleting a session must also delete its whole
// descendant subtree, or the children leak as orphaned session folders.
function descendantsByParent(snapshots) {
	const children = new Map();
	for (const snap of snapshots) {
		const parent = snap.header?.parentSession;
		if (parent === void 0 || parent === null) continue;
		if (!children.has(parent)) children.set(parent, []);
		children.get(parent).push(snap.header.id);
	}
	return children;
}

function collectSubtree(children, id) {
	const out = [];
	// Visited set guards against cyclic parentSession headers (corrupt data),
	// which would otherwise loop forever.
	const visited = new Set([id]);
	const stack = children.get(id) ?? [];
	while (stack.length > 0) {
		const next = stack.pop();
		if (visited.has(next)) continue;
		visited.add(next);
		out.push(next);
		for (const child of children.get(next) ?? []) stack.push(child);
	}
	return out;
}

async function waitUntilCold(ctx, ids, signal, label) {
	// A session is deletable as soon as no agent is ACTIVELY RUNNING on it.
	// The engine keeps a resumed session (and its idle agent) resident in the
	// in-memory store for the whole host lifetime, so keying the guard off
	// store residency would make it impossible to delete any session that was
	// ever opened. Residency is deliberately ignored; only an in-flight turn
	// (agent.status === "running") blocks deletion.
	// FAIL CLOSED: without the agents service there is no observable in-flight
	// turn, so coldness cannot be proven — refuse rather than delete ungated on a
	// destructive route.
	if (ctx.agents === void 0) throw new HttpError(503, "agent runtime is unavailable; refusing to delete without a running-guard");
	const deadline = Date.now() + SETTLE_MS;
	while (true) {
		const live = ids.filter((id) => {
			// agents service may be absent on some hosts; without it there is no
			// observable in-flight turn, so treat the session as cold.
			const agent = ctx.agents?.get?.(id);
			return agent !== void 0 && agent.status === "running";
		});
		if (live.length === 0) return;
		if (Date.now() >= deadline) {
			throw new HttpError(409, `session is active: ${label} is still running; stop it first and try again`);
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_MS));
		signal?.throwIfAborted();
	}
}

async function deleteSession(ctx, sessionId, signal) {
	if (typeof sessionId !== "string" || !ID_PATTERN.test(sessionId)) throw new HttpError(400, "invalid session id");
	const persistence = ctx.sessionPersistence;
	if (typeof persistence?.list !== "function") throw new HttpError(503, "session persistence backend is unavailable");
	const snapshots = await persistence.list();
	if (!Array.isArray(snapshots)) throw new HttpError(503, "session persistence backend is unavailable");
	const byId = new Map(snapshots.map((snap) => [snap.header.id, snap]));
	const target = byId.get(sessionId);
	if (target === void 0) {
		// Unknown id == already gone. Treat it as success (idempotent, matching
		// missing-folder semantics): the end state we were asked for already holds,
		// a re-delete of a just-removed ghost must not error, and the client can
		// trust that any non-2xx response is a REAL failure (a missing endpoint can
		// never be mistaken for success).
		return { ok: true, deleted: [sessionId] };
	}
	const ids = [sessionId, ...collectSubtree(descendantsByParent(snapshots), sessionId)];

	// A single running-guard pass runs right before removal; none is needed up
	// here. (Any first pass cannot close a turn that only starts after it, so an
	// earlier pass would just add up to another SETTLE_MS of latency.)
	const rawRoot = persistence.config?.root ?? persistence.root;
	const root = typeof rawRoot === "string" && rawRoot.length > 0 ? resolve(rawRoot) : defaultRoot();
	const rootDir = sessionDir(root, target.header?.cwd, sessionId);
	// Canonical sessions root, resolved once: a legitimately symlinked root (eg.
	// ~/.dsh/sessions on another disk) must still pass the per-dir "inside root"
	// check below, while a symlink on a dir's own path must not.
	let realRoot;
	try {
		realRoot = await realpath(root);
	} catch (error) {
		if (error?.code === "ENOENT") realRoot = resolve(root);
		else throw error;
	}
	const dirs = [];
	for (const id of ids) {
		const dir = sessionDir(root, byId.get(id)?.header?.cwd, id);
		// Only ENOENT means "already gone" (never-flushed, or removed by an
		// overlapping concurrent delete). Any other stat/readdir error (EACCES,
		// EIO, …) is NOT a permission to proceed: failing to read a folder we are
		// about to rm must abort the delete, never report false success.
		const info = await stat(dir).catch((error) => {
			if (error?.code === "ENOENT") return void 0;
			throw error;
		});
		if (info === void 0 || !info.isDirectory()) continue;
		const entries = await readdir(dir).catch((error) => {
			if (error?.code === "ENOENT") return [];
			throw error;
		});
		// Provability guard: never remove a path we cannot prove is a session folder
		// (must contain a jsonl/jsonl.zstd log or a session.lock). This is the last
		// line of defence against a wrong layout/encoding passing the id checks.
		if (!entries.some((entry) => /\.jsonl(\.zstd)?$/.test(entry) || entry === "session.lock")) {
			throw new HttpError(409, "refusing to delete a path that is not a session directory");
		}
		// Symlink hardening: `stat` follows links, so a symlink swap (on the dir or
		// any of its ancestors) would pass the checks above while `rm` could unlink
		// just a link — "deleted" without deleting. Resolve canonically and require
		// the real path to be the encoded id inside the canonical sessions root, and
		// reject a final component that is itself a symlink.
		const real = await realpath(dir).catch((error) => {
			if (error?.code === "ENOENT") return void 0;
			throw error;
		});
		if (real === void 0) continue; // vanished concurrently (overlapping delete)
		let link;
		try {
			link = await lstat(dir);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}
		if (link.isSymbolicLink() || !real.startsWith(realRoot + sep) || basename(real) !== encodeSegment(id)) {
			throw new HttpError(409, "refusing to delete a path that is not a real session directory");
		}
		dirs.push(dir);
	}
	// The single authoritative running-guard pass, immediately before removal. (A
	// turn that starts after it cannot be closed by any earlier pass, so one pass
	// here is both necessary and sufficient — and keeps the worst-case server-side
	// wait to a single SETTLE_MS, inside the client's retry budget.)
	await waitUntilCold(ctx, ids, signal, sessionId);
	// Remove children before the root, and abort BEFORE the root if any removal
	// fails: the root folder (the discoverable id) must survive a partial failure
	// so a retry still finds it and can reach every leftover folder — no orphans
	// that have become unreachable. Content-addressed attachments
	// (~/.dsh/attachments/v1) are intentionally never touched: they are shared
	// storage, not the session's own files.
	for (let i = dirs.length - 1; i >= 0; i--) {
		if (dirs[i] === rootDir) continue;
		await rm(dirs[i], { recursive: true, force: true });
	}
	await rm(rootDir, { recursive: true, force: true });
	// Registry cleanup as ONE best-effort unit: a registry failure (including a
	// throwing wsr.list — dsh-workspace raises when an order references a missing
	// workspace) must never become an error AFTER the files are gone, which would
	// make the response contradict the actual outcome. Registries are secondary to
	// the removal, and the in-memory engine store entry (not disposable by a
	// plugin) clears at host restart.
	await bestEffort(async () => {
		const wsr = ctx.workspaceRegistry;
		if (wsr === void 0) return;
		const workspaces = typeof wsr.list === "function" ? wsr.list() : [];
		for (const ws of workspaces) {
			const sessionIds = ws.sessionIds ?? [];
			for (const id of ids) {
				if (!sessionIds.includes(id)) continue;
				await bestEffort(() => ws.detachSession(id));
			}
		}
		for (const id of ids) await bestEffort(() => wsr.unarchiveSession(id));
	});
	return { ok: true, deleted: ids };
}

function apply(ctx) {
	// Authenticated browser-session route (same trust class as /api/session.export),
	// mirrored from it. Body is buffered so we control JSON parsing and error codes
	// (400 malformed/missing, 200-already-gone for an unknown id, 409 running or
	// non-session dir, 500 other).
	connectionOf(ctx).fetch.register({
		path: DELETE_SESSION_PATH,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: async (request) => {
			let body;
			try {
				body = await request.json();
			} catch {
				return jsonResponse(400, { error: "invalid JSON body" });
			}
			const sessionId = typeof body?.sessionId === "string" ? body.sessionId : void 0;
			if (sessionId === void 0) return jsonResponse(400, { error: "missing sessionId" });
			try {
				const result = await deleteSession(ctx, sessionId, request.signal);
				return jsonResponse(200, result);
			} catch (error) {
				if (request.signal.aborted) return new Response("aborted", { status: 499 });
				if (error instanceof HttpError) return jsonResponse(error.status, { error: error.message });
				// Never leak internal paths/stack to the client; the operator sees
				// the full error in the host log instead.
				console.error(`[session-delete] ${sessionId}: delete failed unexpectedly`, error);
				return jsonResponse(500, { error: "session delete failed unexpectedly" });
			}
		}
	});
}
