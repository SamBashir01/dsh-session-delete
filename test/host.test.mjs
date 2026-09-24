// Sandboxed tests for the host delete endpoint. Run with `npm test`
// (node --test test/). Nothing here touches the real DSH_HOME or any real service:
// every test builds its own session tree under os.tmpdir() and drives apply() with
// fake services, so the destructive paths are exercised safely and deterministically.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeSegment, projectKey, sessionPath } from "./path-map.mjs";
// The one authoritative mapping used to build sandbox session dirs. Its fidelity to
// the real backend is asserted separately by drift.test.mjs (frozen-source pin).

// Must be set BEFORE the module is imported: the host reads the knobs at load time.
process.env.DSH_SESSION_DELETE_SETTLE_MS = "150";
process.env.DSH_SESSION_DELETE_POLL_MS = "5";
const { apply } = await import("../index.js");

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
	// Raw body variant so validation behavior (malformed JSON, missing field) can
	// be driven exactly as the client would send it.
	const callRaw = (rawBody) =>
		state.registered(
			new Request("http://harness/api/session.delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: rawBody
			})
		);
	return { ctx, state, call, callRaw };
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

test("400 on malformed / missing / invalid sessionId", async () => {
	const root = await freshRoot();
	try {
		const har = makeHarness({ snapshots: [], agents: true });
		har.ctx.sessionPersistence.root = root;

		// Malformed JSON body.
		const a = await har.callRaw("{not json");
		assert.equal(a.status, 400);
		assert.deepEqual(await a.json(), { error: "invalid JSON body" });

		// Absent sessionId field.
		const b = await har.callRaw("{}");
		assert.equal(b.status, 400);
		assert.deepEqual(await b.json(), { error: "missing sessionId" });

		// Non-string sessionId.
		const c = await har.callRaw(JSON.stringify({ sessionId: 42 }));
		assert.equal(c.status, 400);

		// Violates ID_PATTERN (space).
		const d = await har.callRaw(JSON.stringify({ sessionId: "bad id!" }));
		assert.equal(d.status, 400);
		assert.deepEqual(await d.json(), { error: "invalid session id" });

		// Over-length id (300 char cap).
		const e = await har.callRaw(JSON.stringify({ sessionId: "x".repeat(301) }));
		assert.equal(e.status, 400);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("deletes an orphaned subtree even when the parent header is absent", async () => {
	const root = await freshRoot();
	try {
		// The parent session's header is missing (e.g. already archived / purged)
		// yet the child + grandchild folders exist on disk.
		const GRAND_ID = "sess-grand-3";
		await makeSessionDir(root, CWD, CHILD_ID);
		await makeSessionDir(root, CWD, GRAND_ID);
		const snapshots = [
			{ header: { id: CHILD_ID, cwd: CWD, parentSession: "missing-parent-9" } },
			{ header: { id: GRAND_ID, cwd: CWD, parentSession: CHILD_ID } }
		];
		const har = makeHarness({ snapshots, rows: [CHILD_ID, GRAND_ID] });
		har.ctx.sessionPersistence.root = root;

		const res = await har.call(CHILD_ID);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true, deleted: [CHILD_ID, GRAND_ID] });
		await assert.rejects(stat(sessionPath(root, CWD, CHILD_ID)), { code: "ENOENT" });
		await assert.rejects(stat(sessionPath(root, CWD, GRAND_ID)), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// macOS can force `rm` to fail by setting the immutable flag (chflags uchg) on a
// file. That lets us prove the abort-before-root contract: when the removal of a
// descendant fails, the session's own folder (the discoverable id) must survive so
// a retry still finds and removes everything — no unreachable orphans.
test("a failed removal leaves the session dir intact (abort before root)", async (t) => {
	if (process.platform !== "darwin") {
		t.skip("forcing rm to fail needs chflags(2) (macOS only)");
		return;
	}
	const root = await freshRoot();
	let locked = null;
	try {
		const dir = await makeSessionDir(root, CWD, ROOT_ID, ["messages.jsonl", "ledger.jsonl"]);
		locked = join(dir, "ledger.jsonl");
		const set = spawnSync("/usr/bin/chflags", ["uchg", locked]);
		if (set.error !== void 0 || set.status !== 0) {
			t.skip("chflags unavailable on this macOS/filesystem");
			return;
		}
		const snapshots = [{ header: { id: ROOT_ID, cwd: CWD } }];
		const har = makeHarness({ snapshots });
		har.ctx.sessionPersistence.root = root;

		const res = await har.call(ROOT_ID);
		assert.equal(res.status, 500); // the locked file made rm fail
		// The root folder must still exist and still contain the locked file:
		// the delete aborted BEFORE removing rootDir.
		assert.ok((await readdir(dir)).includes("ledger.jsonl"));
	} finally {
		if (locked !== null) spawnSync("/usr/bin/chflags", ["nouchg", locked]);
		await rm(root, { recursive: true, force: true });
	}
});
