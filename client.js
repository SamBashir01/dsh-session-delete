window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _store = require("@deepseek-ai/dsh-client-store");
		let _primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const NS = "session-delete";
		const INITIAL = { bySession: {} };

		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		function hostBase() {
			const origin = globalThis.location?.origin;
			return origin !== void 0 && origin !== "null" ? origin : "http://dsh.internal";
		}

		// Session-scoped delete dialog state + the request that navigates away first.
		var SessionDeleteController = class {
			store = _store.createSnapshotStore(INITIAL);
			active = new Map();
			disposed = false;
			requestDelete(ctx, sessionId) {
				const existing = this.active.get(sessionId);
				if (existing !== void 0) return existing.done;
				if (this.disposed) return Promise.resolve();
				const done = this.run(ctx, sessionId).finally(() => {
					this.active.delete(sessionId);
				});
				this.active.set(sessionId, { done });
				return done;
			}
			async run(ctx, sessionId) {
				this.publish(sessionId, { phase: "deleting", error: null });
				let navigated = false;
				const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
				try {
					// Navigate away (open a new-session preview) BEFORE the request: the host
					// cannot cleanly dispose the currently-open session it does not own, so
					// the folder must leave the active view before we rm it. On failure we
					// best-effort reopen it so the error shows in its own header dialog.
					await ctx.uiWorkspace.startSession();
					navigated = true;
					await sleep(400);
					let response = await fetch(`${hostBase()}/api/session.delete`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId: String(sessionId) })
					});
					// A 409 means an agent is still ACTIVELY running on the session
					// (e.g. a just-submitted turn that is winding down). The host
					// settles for up to ~6s, so retry briefly before giving up.
					for (let attempt = 0; response.status === 409 && attempt < 12; attempt++) {
						await sleep(500);
						response = await fetch(`${hostBase()}/api/session.delete`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ sessionId: String(sessionId) })
						});
					}
					if (!response.ok) {
						const detail = await response.text().catch(() => "");
						throw new Error(`Delete failed: HTTP ${response.status}${detail === "" ? "" : ` ${detail}`}`);
					}
					this.publish(sessionId, null);
				} catch (error) {
					if (this.disposed) return;
					if (navigated) {
						try {
							ctx.uiWorkspace.openSession(sessionId);
						} catch {
							/* reopen is best-effort */
						}
					}
					this.publish(sessionId, { phase: "error", error: messageOf(error) });
				}
			}
			publish(sessionId, entry) {
				this.store.update((state) => {
					const next = { ...state.bySession };
					if (entry === null || entry === void 0) delete next[String(sessionId)];
					else next[String(sessionId)] = entry;
					return { bySession: next };
				});
			}
			dismiss(sessionId) {
				this.publish(sessionId, null);
			}
			async dispose() {
				this.disposed = true;
			}
		};

		// Combined "⋯" header action that shadows the shipped `session-log-download`
		// utilities cell (same id, lower priority, so THIS entry renders) and offers
		// both "Download session log" and "Delete session" in one menu. The download
		// item re-drives the shared @deepseek-ai/dsh-session-log-export controller;
		// the delete item runs our own navigate-first + retry flow. When the
		// log-export plugin is absent, the download item and dialog simply vanish.
		function SessionHeaderUnitAction(props) {
			const { sessionId, t, useSessionDelete, useSessionLogDownload, request, dismiss, requestDownload, dismissDownload } = props;
			const noopHook = () => void 0;
			const deleteEntry = useSessionDelete((state) => state.bySession[String(sessionId)]);
			const phase = deleteEntry?.phase;
			const error = phase === "error" ? deleteEntry?.error ?? t("dialog.commandFailed") : null;
			const downloadHook = useSessionLogDownload ?? noopHook;
			const downloadEntry = downloadHook((state) => state.bySession[String(sessionId)]);
			const downloadStatus = downloadEntry?.status;
			const downloadOpen = downloadEntry?.open === true;
			const downloadError = downloadStatus === "error" ? downloadEntry?.error || t("dl.commandFailed") : null;
			const hasDownload = requestDownload !== void 0 && dismissDownload !== void 0;
			const downloadBusy = hasDownload && downloadStatus === "downloading";
			const [moreOpen, setMoreOpen] = react.useState(false);
			const [dangerOpen, setDangerOpen] = react.useState(false);
			const [acked, setAcked] = react.useState(false);
			const items = [];
			if (hasDownload) {
				items.push({
					id: "download",
					label: t("menu.download"),
					icon: react_jsx_runtime.jsx(_primitives.IconDownloadOutline16, {}),
					disabled: downloadBusy || phase === "deleting"
				});
				items.push({ type: "separator" });
			}
			items.push({
				id: "delete",
				label: t("menu.delete"),
				icon: react_jsx_runtime.jsx(_primitives.IconTrashOutline16, {}),
				danger: true,
				disabled: phase === "deleting" || downloadBusy
			});
			return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
				children: [
					react_jsx_runtime.jsx(_primitives.Menu, {
						open: moreOpen,
						align: "end",
						dense: true,
						onClose: () => setMoreOpen(false),
						items,
						onSelect: (id) => {
							setMoreOpen(false);
							if (id === "download") requestDownload(sessionId);
							else if (id === "delete") {
								setAcked(false);
								setDangerOpen(true);
							}
						},
						anchor: react_jsx_runtime.jsx("button", {
							type: "button",
							className: "sd_moreButton",
							"aria-label": t("header.more"),
							"aria-haspopup": "menu",
							"aria-expanded": moreOpen,
							onClick: () => setMoreOpen((value) => !value),
							children: react_jsx_runtime.jsx(_primitives.IconEllipsisOutline16, {})
						})
					}),
					// Download progress / result dialog, re-driven off the shared
					// log-export controller state (status: downloading|success|error).
					hasDownload &&
						react_jsx_runtime.jsx(_primitives.Modal, {
							open: downloadOpen,
							onClose: () => dismissDownload(sessionId),
							title:
								downloadStatus === "downloading"
									? t("dl.preparingTitle")
									: downloadStatus === "success"
										? t("dl.successTitle")
										: t("dl.errorTitle"),
							description:
								downloadStatus === "downloading"
									? t("dl.preparingDescription")
									: downloadStatus === "success"
										? t("dl.successDescription")
										: downloadError ?? t("dl.commandFailed"),
							closeLabel: t("dl.close"),
							footer: react_jsx_runtime.jsx(_primitives.Button, {
								variant: "primary",
								onClick: () => dismissDownload(sessionId),
								children: t("dl.close")
							})
						}),
					react_jsx_runtime.jsx(_primitives.RiskConfirmation, {
						open: dangerOpen,
						title: t("confirm.title"),
						description: t("confirm.description"),
						acknowledgeLabel: t("confirm.acknowledge"),
						cancelLabel: t("confirm.cancel"),
						closeLabel: t("confirm.close"),
						confirmLabel: t("confirm.confirm"),
						acknowledged: acked,
						onAcknowledgedChange: setAcked,
						onCancel: () => setDangerOpen(false),
						onConfirm: () => {
							setDangerOpen(false);
							request(sessionId);
						}
					}),
					react_jsx_runtime.jsx(_primitives.Modal, {
						open: phase === "error",
						onClose: () => dismiss(sessionId),
						title: t("dialog.errorTitle"),
						description: error ?? t("dialog.commandFailed"),
						closeLabel: t("dialog.close"),
						footer: react_jsx_runtime.jsx(_primitives.Button, {
							variant: "primary",
							onClick: () => dismiss(sessionId),
							children: t("dialog.close")
						})
					})
				]
			});
		}

		// Styles for the more button (kept minimal, mirrors the shipped header button).
		const styleId = "dsh-session-delete/action";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css='" + styleId + "']") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-delete";
			tag.dataset.pluginCss = styleId;
			tag.textContent =
				".sd_moreButton{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:28px;flex:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}.sd_moreButton svg{width:15px;height:15px}.sd_moreButton:hover{background:var(--dsw-alias-interactive-bg-hover)}";
			document.head.appendChild(tag);
		}

		// Dictionaries. Download strings are namespaced under "dl.*" (copied verbatim from
		// @deepseek-ai/dsh-session-log-export so the shadowed download dialog reads the
		// same text) and deliberately avoid colliding with the delete dialog's "dialog.*"
		// keys inside the same "session-delete" namespace.
		const zh = {
			"header.more": "更多操作",
			"menu.download": "下载 Session 日志",
			"menu.delete": "删除此会话",
			"dl.preparingTitle": "正在导出 Session",
			"dl.preparingDescription": "正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。",
			"dl.successTitle": "Session 导出已开始下载",
			"dl.successDescription": "浏览器正在下载 Session ZIP 文件。",
			"dl.errorTitle": "Session 导出失败",
			"dl.commandFailed": "无法启动 Session 导出。",
			"dl.close": "关闭",
			"confirm.title": "永久删除此会话？",
			"confirm.description": "此会话及其所有子会话的本地记录将被永久删除，且无法恢复。已引用的文件附件（Attachment）不会一并删除。",
			"confirm.acknowledge": "我了解此操作无法撤销",
			"confirm.cancel": "取消",
			"confirm.close": "关闭",
			"confirm.confirm": "永久删除",
			"dialog.errorTitle": "删除失败",
			"dialog.close": "关闭",
			"dialog.commandFailed": "无法删除此会话。"
		};

		const en = {
			"header.more": "More actions",
			"menu.download": "Download session log",
			"menu.delete": "Delete session",
			"dl.preparingTitle": "Exporting Session",
			"dl.preparingDescription": "Preparing a ZIP containing this Session, its sub-Sessions, and attachments.",
			"dl.successTitle": "Session download started",
			"dl.successDescription": "The browser is downloading the Session ZIP.",
			"dl.errorTitle": "Session export failed",
			"dl.commandFailed": "Could not start the Session export.",
			"dl.close": "Close",
			"confirm.title": "Delete this session permanently?",
			"confirm.description": "This session and all of its sub-sessions will be permanently removed from your local records and cannot be recovered. Referenced file attachments are not deleted.",
			"confirm.acknowledge": "I understand this cannot be undone",
			"confirm.cancel": "Cancel",
			"confirm.close": "Close",
			"confirm.confirm": "Delete permanently",
			"dialog.errorTitle": "Delete failed",
			"dialog.close": "Close",
			"dialog.commandFailed": "Could not delete this session."
		};

		// `sessionLogDownload` must be declared so `ctx.get` is permitted; it lets us
		// re-drive the shared download controller. It is always provided by the
		// shipped @deepseek-ai/dsh-session-log-export plugin alongside this profile.
		const inject = ["slots", "locale", "uiWorkspace", "sessionLogDownload"];

		function apply(ctx) {
			const controller = new SessionDeleteController();
			ctx.provide("sessionDelete", controller);
			ctx.effect(() => async () => {
				await controller.dispose();
			}, "session-delete: browser delete lifecycle");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-delete: browser dictionaries");
			// Shadow the shipped `session-log-download` cell: same id, lower priority
			// (lowest renders), so our combined menu replaces the built-in ⋯ button
			// and auto-falls back to it if this plugin is disabled.
			ctx.slots.inject("conversation.session.header.utilities", () =>
				ctx.slots.register(
					{
						name: "conversation.session.header.utilities",
						id: "session-log-download",
						priority: -1,
						locale: NS,
						inject: () => {
							const download = ctx.get("sessionLogDownload");
							return {
								hooks: {
									sessionDelete: controller.store,
									sessionLogDownload: download?.store
								},
								request: (sessionId) => controller.requestDelete(ctx, sessionId),
								dismiss: (sessionId) => {
									controller.dismiss(sessionId);
								},
								requestDownload: (sessionId) =>
									download?.download(String(sessionId)),
								dismissDownload: (sessionId) =>
									download?.dismiss(String(sessionId))
							};
						}
					},
					SessionHeaderUnitAction
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
