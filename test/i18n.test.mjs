// i18n parity check for the browser bundle.
//
// client.js carries two locale dictionaries (`const zh = { ... }` / `const en = {
// ... }`). Their key sets MUST match exactly — a key present in one and missing in
// the other means a user in that locale silently gets no copy (the UI falls back
// to nothing or raw), which is exactly the class of bug a reviewer flagged before
// (unlocalized dialog text). This test scans the source itself rather than trying
// to import the browser-bundle module (which needs a DOM).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(join(here, "..", "client.js"), "utf8");

// Skip a string literal (", ', `) honoring backslash escapes; returns the index of
// the closing quote.
function skipString(src, start, quote) {
	let p = start + 1;
	while (p < src.length) {
		if (src[p] === "\\") p += 2;
		else if (src[p] === quote) return p;
		else p += 1;
	}
	return src.length - 1;
}

// Collect the flattened top-level keys of an object literal by scanning until its
// closing brace, ignoring strings/comments and any nested objects (nested keys are
// irrelevant here — we only need the locale-dict key CONTRACT, which is flat in
// our dictionaries, with dotted string keys like "dialog.busy").
function objectKeys(src, marker) {
	const start = src.indexOf(marker);
	assert.ok(start !== -1, `missing marker ${marker} in client.js`);
	let brace = src.indexOf("{", start);
	let depth = 0;
	const keys = new Set();
	let cur = "";
	let afterColon = false;
	for (let i = brace; i < src.length; i++) {
		const ch = src[i];
		if (ch === "}" && depth === 0) break;
		if (ch === '"' || ch === "'" || ch === "`") {
			const end = skipString(src, i, ch);
			// A quoted STRING at a key position (depth 1, before a colon) is a key
			// literal — our dictionaries use dotted names like "menu.delete", so
			// capture the content instead of throwing it away like plain strings.
			if (depth === 1 && !afterColon && end > i + 1) {
				const key = src.slice(i + 1, end);
				if (key !== " ") keys.add(key);
			}
			i = end;
			continue;
		}
		if (ch === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			if (end === -1) break;
			i = end + 1;
			continue;
		}
		if (ch === "{") {
			depth += 1;
			if (depth === 1) {
				cur = "";
				afterColon = false;
			}
			continue;
		}
		if (ch === "}") {
			depth -= 1;
			if (depth === 0) break;
			continue;
		}
		if (depth === 1 && !afterColon) {
			if (/[A-Za-z0-9_.$]/.test(ch)) cur += ch;
			else if (ch === ":") {
				if (cur.length > 0) keys.add(cur);
				cur = "";
				afterColon = true;
			} else if (!/\s/.test(ch)) {
				cur = ""; // stray punctuation resets the pending identifier
			}
		} else if (depth === 1 && afterColon) {
			if (ch === "," || ch === "\n") afterColon = false;
		}
	}
	return keys;
}

const zh = objectKeys(clientSrc, "const zh = {");
const en = objectKeys(clientSrc, "const en = {");

test("zh and en dictionaries expose exactly the same keys", () => {
	assert.ok(zh.size >= 20, `expected a substantial zh dictionary, got ${zh.size}`);
	assert.deepEqual([...zh].sort(), [...en].sort());
});

test("critical user-facing keys are defined in both locales", () => {
	const critical = ["menu.delete", "confirm.confirm", "dialog.errorTitle", "dialog.busy", "dialog.networkError"];
	for (const key of critical) {
		assert.ok(zh.has(key), `zh missing ${key}`);
		assert.ok(en.has(key), `en missing ${key}`);
	}
});
