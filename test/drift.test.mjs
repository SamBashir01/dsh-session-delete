// Drift pin for the replicated path encoding.
//
// The plugin deletes folders computed by re-implementations of two module-private
// functions from @deepseek-ai/dsh-session-persistence-jsonl (encodeSegment /
// projectKey). A copy that diverges from the backend means we stat/remove the
// WRONG directory — the most dangerous possible failure. The upstream functions
// are not exported, so `test/path-map.mjs` pins the algorithm against a frozen
// snapshot of the real source (fixtures/session-path-0.1.6-alpha.2.txt), and the
// shipped copies in ../index.js build their own paths from the same algorithm.
// Honesty is enforced BEHAVIORALLY (not by raw source-text equality, which breaks
// on harmless error-wording differences): a deterministic 2000-case fuzz corpus,
// plus fixed regression anchors. A divergence in any of these is a
// release-blocker, not a nicety.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encodeSegment, projectKey } from "./path-map.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureSrc = readFileSync(join(here, "fixtures", "session-path-0.1.6-alpha.2.txt"), "utf8");
const indexSrc = readFileSync(join(here, "..", "index.js"), "utf8");

// Extract a top-level `function <name>(...) { ... }` from JS source by brace
// matching — safe here because the renderings all define them at top level.
function extractFun(src, name) {
	const start = src.indexOf("function " + name + "(");
	if (start === -1) throw new Error(`missing function ${name} in source`);
	let i = src.indexOf("{", start);
	let depth = 0;
	for (; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) break;
		}
	}
	return src.slice(start, i + 1);
}

// Re-materialize a rendering's two path functions from its own source.
function makeFns(src) {
	return new Function(
		extractFun(src, "encodeSegment") + "\n" + extractFun(src, "projectKey") + "\nreturn { encodeSegment, projectKey };"
	)();
}
const shipped = makeFns(indexSrc); // ../index.js's own path computation
const upstream = makeFns(fixtureSrc); // frozen real backend source
test("frozen upstream snapshot is present and non-trivial", () => {
	// The fixture is a COPY of module-private upstream source; this guards against
	// it being accidentally emptied/truncated (which would vacuously pass).
	for (const name of ["encodeSegment", "projectKey"]) {
		const fn = extractFun(fixtureSrc, name);
		assert.ok(fn.length > 150, `${name} looks truncated in the fixture (${fn.length} chars)`);
		assert.match(fn, /function\s+/, `${name} is a function`);
	}
	// The hex-rewrite machinery (the part most likely to drift) must be present.
	assert.match(fixtureSrc, /padStart\(4\s*,\s*"0"\)/, "fixture keeps the ~XXXX hex escape");
});

// Deterministic PRNG so the fuzz corpus is reproducible.
function mulberry32(seed) {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test("fuzz: path encoders agree with the frozen snapshot on random inputs", () => {
	// Two renderings must match the real backend byte-for-byte across the corpus:
	// - the test-local canonical copies (path-map.mjs) used to build sandbox dirs,
	// - the shipped copies in ../index.js that actually compute the paths to delete.
	const renderings = { "path-map.mjs": { encodeSegment, projectKey }, "index.js": shipped };
	const rand = mulberry32(0xc0ffee);
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.~/\\:é汉~.%\t\n";
	const run = (fn, ref, input, label) => {
		const out = {};
		const refOut = {};
		try { out.v = fn(input); } catch { out.e = true; }
		try { refOut.v = ref(input); } catch { refOut.e = true; }
		assert.equal(out.e ?? false, refOut.e ?? false, `${label} throw mismatch for ${JSON.stringify(input)}`);
		if (!out.e) assert.equal(out.v, refOut.v, `${label} mismatch for ${JSON.stringify(input)}`);
	};
	for (let n = 0; n < 2000; n++) {
		const len = Math.floor(rand() * 24);
		let cwd = "";
		for (let i = 0; i < len; i++) cwd += alphabet[Math.floor(rand() * alphabet.length)];
		if (n % 97 === 0) cwd = "x".repeat(50 + Math.floor(rand() * 260)); // long paths

		const idLen = Math.floor(rand() * 20);
		let id = "";
		for (let i = 0; i < idLen; i++) id += alphabet[Math.floor(rand() * alphabet.length)];

		for (const [name, fns] of Object.entries(renderings)) {
			run(fns.projectKey, upstream.projectKey, cwd, `${name} projectKey`);
			run(fns.encodeSegment, upstream.encodeSegment, id, `${name} encodeSegment`);
		}
	}
});

test("well-known path encodings stay stable (regression anchor)", () => {
	// All three renderings must agree with each other and with the frozen upstream.
	for (const [name, fns] of Object.entries({ "path-map.mjs": { encodeSegment, projectKey }, "index.js": shipped })) {
		assert.equal(fns.encodeSegment("."), "~002E", `${name} encode .`);
		assert.equal(fns.encodeSegment(".."), "~002E~002E", `${name} encode ..`);
		assert.equal(fns.encodeSegment("sess-root-1"), "sess-root-1", `${name} safe id passthrough`);
		assert.equal(fns.projectKey("/work/proj-a"), "--work-proj-a--", `${name} projectKey`);
		assert.equal(fns.projectKey("/"), "--root--", `${name} root projectKey`);
		// Empty cwd / segment must throw, never silently encode.
		assert.throws(() => fns.projectKey(""), /empty/, `${name} empty cwd throws`);
		assert.throws(() => fns.encodeSegment(""), /empty/, `${name} empty id throws`);
	}
	assert.equal(upstream.projectKey("/work/proj-a"), "--work-proj-a--");
	assert.equal(upstream.encodeSegment("sess-root-1"), "sess-root-1");
});
