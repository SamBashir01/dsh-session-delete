// Sandboxed tests for the host delete endpoint. Run with `npm test`
// (node --test test/). Nothing here touches the real DSH_HOME or any real service:
// every test builds its own session tree under os.tmpdir() and drives apply() with
// fake services, so the destructive paths are exercised safely and deterministically.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Must be set BEFORE the module is imported: the host reads the knobs at load time.
process.env.DSH_SESSION_DELETE_SETTLE_MS = "150";
process.env.DSH_SESSION_DELETE_POLL_MS = "5";
const { apply } = await import("../index.js");

// ---- Path mapping, re-derived here from the published JSONL layout ----
// This mirrors (rather than imports) encodeSegment/projectKey so that if the
// plugin's replicated mapping ever drifts from the backend layout, the delete will
// fail to find the test folder we build at this independently-computed path.
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("empty segment");
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
	if (cwd.length === 0) throw new Error("empty cwd");
	let readable = "";
	let separatorRun = false;
	for (const ch of cwd) {
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
function sessionPath(root, cwd, id) {
	return join(root, projectKey(cwd), encodeSegment(id));
}

// ---- Fixture: fake ctx + captured route handler ----
async function freshRoot() {
	return mkdtemp(join(tmpdir(), "dsh-session-delete-test-"));
}

function makeHarness({ snapshots = [], rows = [], agents, registryListThrows = false } = {}) {
	const state = { detached: [], unarchived: [], registered: null };
	const ctx = {
		connection: { fetch: { register: (route) => { state.registered = route.fetch; } } },
		sessionPersistence: { root: null, list: async () => snapshots },
		workspaceRegistry: {
			list() {
				if (registryListThrows) throw new Error("workspace order refers to a missing workspace");
				return rows.map((id) => ({
					sessionIds: [id],
					detachSession: async () => state.detached.push(id)
				}));
			},
			unarchiveSession: async (id) => state.unarchived.push(id)
		}
	};
	if (agents === false) ctx.agents = void 0;
	else {
		// Default (true / omitted) = live agents service with everything idle.
		const agentsGet = agents === true || agents === void 0 ? () => void 0 : () => agents.get();
		ctx.agents = { get: agentsGet };
	}
	apply(ctx);
	const call = (sessionId) =>
		state.registered(
			new Request("http://harness/api/session.delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId })
			})
		);
	return { ctx, state, call };
}

async function makeSessionDir(root, cwd, id, contents = ["messages.jsonl"]) {
	const dir = sessionPath(root, cwd, id);
	await mkdir(dir, { recursive: true });
	for (const f of contents) await writeFile(join(dir, f), "x");
	return dir;
}

const CWD = "/work/proj-a";
const ROOT_ID = "sess-root-1";
const CHILD_ID = "sess-child-2";

// ---- Tests ----

test("happy path: removes root + child dirs and cleans registries for every id", async () => {
	const root = await freshRoot();
	try {
		await makeSessionDir(root, CWD, ROOT_ID);
		await makeSessionDir(root, CWD, CHILD_ID);
		const snapshots = [
			{ header: { id: ROOT_ID, cwd: CWD } },
			{ header: { id: CHILD_ID, cwd: CWD, parentSession: ROOT_ID } }
		];
		const har = makeHarness({ snapshots, rows: [ROOT_ID, CHILD_ID] });
		har.ctx.sessionPersistence.root = root;

		const res = await har.call(ROOT_ID);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true, deleted: [ROOT_ID, CHILD_ID] });
		await assert.rejects(stat(sessionPath(root, CWD, ROOT_ID)), { code: "ENOENT" });
		await assert.rejects(stat(sessionPath(root, CWD, CHILD_ID)), { code: "ENOENT" });
		assert.deepEqual([...har.state.detached].sort(), [CHILD_ID, ROOT_ID]);
		assert.deepEqual([...har.state.unarchived].sort(), [CHILD_ID, ROOT_ID]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("unknown id is already-gone success (idempotent, nothing to do)", async () => {
	const root = await freshRoot();
	try {
		const har = makeHarness({ snapshots: [], agents: true });
		har.ctx.sessionPersistence.root = root;
		const res = await har.call("ghost-id-9");
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true, deleted: ["ghost-id-9"] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses while a turn is running (409) and removes nothing", async () => {
	const root = await freshRoot();
	try {
		const dir = await makeSessionDir(root, CWD, ROOT_ID);
		const snapshots = [{ header: { id: ROOT_ID, cwd: CWD } }];
		const har = makeHarness({ snapshots, agents: { get: () => ({ status: "running" }) } });
		har.ctx.sessionPersistence.root = root;

		const res = await har.call(ROOT_ID);
		assert.equal(res.status, 409);
		// Folder fully intact after the (short) settle wait.
		assert.ok((await readdir(dir)).includes("messages.jsonl"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses (503) when the agents runtime is missing — guard fails closed, nothing removed", async () => {
	const root = await freshRoot();
	try {
		const dir = await makeSessionDir(root, CWD, ROOT_ID);
		const snapshots = [{ header: { id: ROOT_ID, cwd: CWD } }];
		const har = makeHarness({ snapshots, agents: false });
		har.ctx.sessionPersistence.root = root;

		const res = await har.call(ROOT_ID);
		assert.equal(res.status, 503);
		assert.ok((await readdir(dir)).includes("messages.jsonl"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses a folder that is not provably a session dir (409) and leaves it", async () => {
	const root = await freshRoot();
	try {
		const dir = await makeSessionDir(root, CWD, ROOT_ID, ["notes.txt"]);
		const snapshots = [{ header: { id: ROOT_ID, cwd: CWD } }];
		const har = makeHarness({ snapshots });
		har.ctx.sessionPersistence.root = root;

		const res = await har.call(ROOT_ID);
		assert.equal(res.status, 409);
		assert.ok((await readdir(dir)).includes("notes.txt"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses when the session path resolves through a symlink (409), target untouched", async () => {
	const root = await freshRoot();
	try {
		// A real session folder lives OUTSIDE the derived path (the "swap" target).
		const outside = await freshRoot();
		const jail = await makeSessionDir(outside, CWD, ROOT_ID, ["messages.jsonl"]);
		// The derived path's final component is a symlink pointing at it.
		await mkdir(join(root, projectKey(CWD)), { recursive: true });
		await symlink(jail, sessionPath(root, CWD, ROOT_ID), "dir");

		const snapshots = [{ header: { id: ROOT_ID, cwd: CWD } }];
		const har = makeHarness({ snapshots });
		har.ctx.sessionPersistence.root = root;

		const res = await har.call(ROOT_ID);
		assert.equal(res.status, 409);
		assert.ok((await readdir(jail)).includes("messages.jsonl")); // target untouched
		await rm(outside, { recursive: true, force: true });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a throwing workspaceRegistry.list() cannot turn success into an error", async () => {
	const root = await freshRoot();
	try {
		await makeSessionDir(root, CWD, ROOT_ID);
		const snapshots = [{ header: { id: ROOT_ID, cwd: CWD } }];
		const har = makeHarness({ snapshots, registryListThrows: true });
		har.ctx.sessionPersistence.root = root;

		const res = await har.call(ROOT_ID);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true, deleted: [ROOT_ID] });
		await assert.rejects(stat(sessionPath(root, CWD, ROOT_ID)), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
