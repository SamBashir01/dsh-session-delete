// Canonical local copies of the JSONL backend path encoders, shared by all tests.
//
// These are the "independent pin": both /index.js and this module replicate the
// backend algorithm (which is module-private upstream), and the drift test
// (drift.test.mjs) asserts that BOTH stay byte-equal to a frozen snapshot of the
// real source from @deepseek-ai/dsh-session-persistence-jsonl@0.1.6-alpha.2
// (test/fixtures/session-path-0.1.6-alpha.2.txt). If a copy ever drifts, a delete
// would target the wrong directory, so a failing drift test is a release-blocker.
import { join } from "node:path";
export function encodeSegment(raw) {
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
export function projectKey(cwd) {
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
export function sessionPath(root, cwd, id) {
	return join(root, projectKey(cwd), encodeSegment(id));
}
