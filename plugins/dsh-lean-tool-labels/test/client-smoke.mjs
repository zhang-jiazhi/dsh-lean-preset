/**
 * Smoke test for the @local/dsh-lean-tool-labels client half.
 *
 * The browser bundle calls `window.__ModuleLoader__.load(...)`; this test shims
 * that loader, evaluates the bundle, then exercises the summary helpers and the
 * slot/locale registration with test doubles. Run with:
 *
 *   node test/client-smoke.mjs
 */
import assert from "node:assert/strict";

let captured = null;
globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			captured = spec;
		}
	}
};

await import("../lib/client.js");
assert.ok(captured !== null, "bundle calls window.__ModuleLoader__.load");
assert.equal(captured.id, "@local/dsh-lean-tool-labels");
assert.equal(typeof captured.factory, "function");

const reactStub = {
	memo: (component) => component,
	useMemo: (compute) => compute(),
	useState: (value) => [value, () => {}],
	useEffect: () => {}
};
const jsxStub = {
	jsx: (type, props) => ({ type, props }),
	jsxs: (type, props) => ({ type, props }),
	Fragment: Symbol.for("react.fragment")
};
const primitivesStub = { DisclosureRow: function DisclosureRow() {} };
const requireShim = (id) => {
	if (id === "react") return reactStub;
	if (id === "react/jsx-runtime") return jsxStub;
	if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
	throw new Error(`unexpected require("${id}")`);
};

const face = captured.factory(requireShim);
const { NS, OWNED_TOOLS, zh, en, summarize, stateOf, resultText, parseArgs, LeanToolLabelRow } = face.__internals;

/* ---------------- dictionaries stay in sync ---------------- */
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
for (const key of Object.keys(zh)) assert.notEqual(zh[key].trim(), "", `zh.${key}`);

/* ---------------- only the lean preset's own tools are taken over ---------------- */
assert.deepEqual(OWNED_TOOLS, ["dev_tool_search", "rule_load"]);
assert.equal(NS, "lean-tool-labels");

/* ---------------- dev_tool_search summaries ---------------- */
const t = (key, params = {}) => {
	let text = zh[key] ?? key;
	for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value));
	return text;
};
assert.equal(
	summarize("dev_tool_search", { toolNames: ["mcp__playwright__browser_navigate", "mcp__playwright__browser_snapshot", "mcp__playwright__browser_evaluate"] }, t),
	"解锁 mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot +1"
);
assert.equal(summarize("dev_tool_search", { toolNames: ["browser"] }, t), "解锁 browser");
assert.equal(summarize("dev_tool_search", { query: "web" }, t), "搜索 web");
assert.equal(summarize("dev_tool_search", { query: "  " }, t), "未提供参数");
assert.equal(summarize("dev_tool_search", {}, t), "未提供参数");
assert.equal(summarize("dev_tool_search", undefined, t), "未提供参数");
/* An empty array must not be read as "unlock nothing" while a query is present. */
assert.equal(summarize("dev_tool_search", { toolNames: [], query: "memory" }, t), "搜索 memory");
assert.equal(summarize("dev_tool_search", { toolNames: [1, "", null], query: "x" }, t), "搜索 x");

/* ---------------- rule_load summaries ---------------- */
assert.equal(summarize("rule_load", { sections: ["5"] }, t), "加载第 5 章");
assert.equal(summarize("rule_load", { sections: ["5", "编码"] }, t), "加载第 5, 编码 章");
assert.equal(summarize("rule_load", { sections: [] }, t), "未指定章节");
assert.equal(summarize("rule_load", {}, t), "未指定章节");
assert.equal(summarize("rule_load", { sections: [5] }, t), "未指定章节");

/* ---------------- argument parsing never throws ---------------- */
assert.deepEqual(parseArgs('{"query":"x"}'), { query: "x" });
assert.equal(parseArgs("not json"), undefined);
assert.equal(parseArgs(""), undefined);
assert.equal(parseArgs(undefined), undefined);

/* ---------------- node state and result flattening ---------------- */
assert.equal(stateOf({ argsRaw: "{}" }), "running");
assert.equal(stateOf({ kind: "result", content: [] }), "ok");
assert.equal(stateOf({ kind: "result", content: [], isError: true }), "error");
assert.equal(stateOf({ kind: "result", content: [], error: { name: "E", code: "interrupted" } }), "stopped");
assert.equal(stateOf({ kind: "result", content: [], error: { name: "E", code: "boom" } }), "error");
assert.equal(resultText({ content: [{ type: "text", text: "ok" }] }), "ok");
assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
assert.equal(resultText({ content: [], error: { name: "Error", code: "boom" } }), "Error: boom");
assert.equal(resultText({ content: [] }), "");

/* ---------------- a settled call renders without expanding ---------------- */
const row = LeanToolLabelRow({
	toolName: "rule_load",
	block: { kind: "result", call: { argsRaw: '{"sections":["5"]}' }, content: [{ type: "text", text: "Loaded." }] },
	t
});
assert.equal(row.props.title, "规则加载");
assert.equal(row.props.expandable, true);
assert.equal(row.props.collapsedContent.props.children[1].props.children, "加载第 5 章");
assert.equal(row.props.icon.props["aria-hidden"], true);

/* ---------------- a running call already shows the intended summary ---------------- */
const running = LeanToolLabelRow({
	toolName: "dev_tool_search",
	block: { argsRaw: '{"toolNames":["browser"]}' },
	t
});
assert.equal(running.props.expandable, true);
assert.equal(running.props.collapsedContent.props.children[0].props.children, "运行中");
assert.equal(running.props.collapsedContent.props.children[1].props.children, "解锁 browser");

/* ---------------- a call with no arguments stays unexpandable ---------------- */
const empty = LeanToolLabelRow({ toolName: "rule_load", block: { argsRaw: "" }, t });
assert.equal(empty.props.expandable, false);

/* ---------------- malformed arguments fall back instead of throwing ---------------- */
const malformed = LeanToolLabelRow({ toolName: "rule_load", block: { argsRaw: "{oops" }, t });
assert.equal(malformed.props.collapsedContent.props.children[1].props.children, "未指定章节");
assert.equal(malformed.props.expandable, true);

/* ---------------- registration shape ---------------- */
const injections = [];
const registrations = [];
const ctx = {
	effect(fn) {
		fn();
	},
	locale: { register: (ns) => assert.equal(ns, NS) },
	slots: {
		inject(name, fn) {
			injections.push(name);
			fn();
		},
		register(spec, component) {
			registrations.push([spec, component]);
		}
	}
};
globalThis.document = { head: { appendChild() {} }, createElement: () => ({ dataset: {}, remove() {} }) };
face.apply(ctx);
assert.equal(registrations.length, 2);
assert.deepEqual(registrations.map(([spec]) => spec.key), OWNED_TOOLS);
assert.deepEqual(injections, ["tool.call.toolview", "tool.call.toolview"]);
for (const [spec, component] of registrations) {
	assert.equal(spec.name, "tool.call.toolview");
	assert.equal(spec.locale, NS);
	assert.equal(component, LeanToolLabelRow);
}

console.log("lean-tool-labels client smoke: ok");
