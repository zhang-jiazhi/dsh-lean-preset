window.__ModuleLoader__.load({
	id: "@local/dsh-lean-tool-labels",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const NS = "lean-tool-labels";

		/**
		 * Collapsed-row copy. The generic row derives its summary from a fixed
		 * key list; neither `toolNames` (an array) nor an empty `query` matches
		 * one, so it falls back to echoing the whole argument JSON. These two
		 * tools therefore own their row.
		 */
		const zh = {
			"tool.title.dev_tool_search": "工具发现",
			"tool.title.rule_load": "规则加载",
			"dev.unlock": "解锁 {names}",
			"dev.query": "搜索 {query}",
			"dev.idle": "未提供参数",
			"rules.sections": "加载第 {sections} 章",
			"rules.none": "未指定章节",
			"row.input": "输入",
			"row.result": "结果",
			"row.running": "运行中",
			"row.failed": "失败",
			"row.stopped": "已中断",
		};
		const en = {
			"tool.title.dev_tool_search": "Tool discovery",
			"tool.title.rule_load": "Load rules",
			"dev.unlock": "Unlock {names}",
			"dev.query": "Search {query}",
			"dev.idle": "No arguments",
			"rules.sections": "Load sections {sections}",
			"rules.none": "No section given",
			"row.input": "Input",
			"row.result": "Result",
			"row.running": "Running",
			"row.failed": "Failed",
			"row.stopped": "Stopped",
		};

		/** Bare CSS: one compact summary line that truncates instead of wrapping. */
		const CSS = [
			".leanToolLabelRow{display:flex;align-items:center;gap:6px;min-width:0}",
			".leanToolLabelSummary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75}",
			".leanToolLabelBody{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;opacity:.85}",
		].join("");

		/** Parse one call's raw argument JSON; malformed input keeps the raw text. */
		function parseArgs(raw) {
			try {
				return JSON.parse(raw);
			} catch {
				return undefined;
			}
		}

		/** Flatten a settled node the same way the shipped generic row does. */
		function resultText(node) {
			const parts = [];
			// node 可能为 null/undefined（不完整 payload）；content 也可能不是数组。
			const content = node !== null && typeof node === "object" && Array.isArray(node.content) ? node.content : [];
			for (const block of content) {
				if (block === null || typeof block !== "object") continue;
				if (block.type === "text") parts.push(block.text);
				else {
					// 循环引用的块会让 JSON.stringify 抛错，同样发生在 render 阶段。
					try {
						parts.push(JSON.stringify(block, null, 2));
					} catch {
						parts.push(String(block));
					}
				}
			}
			if (parts.length === 0 && node?.error !== undefined) parts.push(`${node.error.name}: ${node.error.code}`);
			return parts.join("\n");
		}

		/** One-line account of what this call asked for. */
		function summarize(toolName, args, t) {
			if (toolName === "dev_tool_search") {
				const names = Array.isArray(args?.toolNames) ? args.toolNames.filter((name) => typeof name === "string" && name !== "") : [];
				if (names.length > 0) {
					const head = names.slice(0, 2).join(", ");
					return t("dev.unlock", { names: names.length > 2 ? `${head} +${names.length - 2}` : head });
				}
				const query = typeof args?.query === "string" ? args.query.trim() : "";
				return query === "" ? t("dev.idle") : t("dev.query", { query });
			}
			const sections = Array.isArray(args?.sections) ? args.sections.filter((value) => typeof value === "string" && value !== "") : [];
			return sections.length === 0 ? t("rules.none") : t("rules.sections", { sections: sections.join(", ") });
		}

		/**
		 * payload 是否为可安全读取属性的对象。
		 *
		 * 宿主 `tool.call.toolview` slot 在不完整状态（插件热重载中间态、宿主版本
		 * 升级后 payload 形状变化）可能传入 null/undefined —— 裸 `"kind" in block`
		 * 会抛 TypeError，而它发生在 **render 阶段**：没有错误边界时整块区域白屏，
		 * 不是只坏一行。
		 */
		function isPayload(value) {
			return value !== null && typeof value === "object";
		}

		/** Row state from the frozen node, matching the shipped vocabulary. */
		function stateOf(block) {
			if (!isPayload(block)) return "running";
			if (!("kind" in block)) return "running";
			if (block.error?.code === "interrupted") return "stopped";
			return block.error !== undefined || block.isError === true ? "error" : "ok";
		}

		/**
		 * Keyed row for `dev_tool_search` and `rule_load`.
		 *
		 * The summary stays a pure function of the call's own arguments, so a
		 * running row already reads correctly; the body keeps the untruncated
		 * arguments and the full result behind the disclosure.
		 * @param props - keyed toolview payload plus the locale seat.
		 * @returns the compact labeled row.
		 */
		function LeanToolLabelRow({ toolName, block, t }) {
			const done = isPayload(block) && "kind" in block;
			const argsRaw = (done ? block.call?.argsRaw : block?.argsRaw) ?? "";
			const state = stateOf(block);
			const summary = summarize(toolName, parseArgs(argsRaw), t);
			const output = done ? resultText(block) || null : null;
			const expandable = argsRaw !== "" || output !== null;
			const [expanded, setExpanded] = react.useState(false);
			const open = expanded && expandable;
			const toggle = () => setExpanded((value) => !value);
			const status = state === "running" ? t("row.running") : state === "error" ? t("row.failed") : state === "stopped" ? t("row.stopped") : null;
			const children = [];
			if (open && argsRaw !== "") children.push(jsxRuntime.jsx("pre", { key: "input", className: "leanToolLabelBody", children: argsRaw }));
			if (open && output !== null) children.push(jsxRuntime.jsx("pre", { key: "result", className: "leanToolLabelBody", children: output }));
			return jsxRuntime.jsx(primitives.DisclosureRow, {
				icon: jsxRuntime.jsx("span", { "aria-hidden": true, children: "\u25cf" }),
				title: t(`tool.title.${toolName}`),
				open,
				expandable,
				onToggle: toggle,
				expandOnRowClick: true,
				keepContentWhenOpen: true,
				rowClassName: "leanToolLabelRow",
				collapsedContent: jsxRuntime.jsxs(jsxRuntime.Fragment, {
					children: [
						status !== null ? jsxRuntime.jsx("span", { style: { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }, children: status }) : null,
						jsxRuntime.jsx("span", { className: "leanToolLabelSummary", "data-state": state, children: summary }),
					],
				}),
				children,
			});
		}

		/** The two tools this package owns; every other tool keeps the generic row. */
		const OWNED_TOOLS = ["dev_tool_search", "rule_load"];

		/** Client services the registrations need. */
		const inject = ["slots", "locale"];

		/**
		 * Register the dictionaries and one keyed view per owned tool.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "@local/dsh-lean-tool-labels";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => tag.remove();
			}, "lean-tool-labels: styles");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "lean-tool-labels: dictionaries");
			for (const key of OWNED_TOOLS) {
				ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
					name: "tool.call.toolview",
					key,
					locale: NS,
				}, LeanToolLabelRow)), `lean-tool-labels: ${key}`);
			}
		}

		/** Pure helpers exposed for the package smoke test. */
		exports.__internals = { NS, OWNED_TOOLS, zh, en, summarize, stateOf, resultText, parseArgs, LeanToolLabelRow };
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
