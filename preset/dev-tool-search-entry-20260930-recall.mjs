// New entry and import URL bypass cached implementations on new preset revisions.
// 20260930-recall: fix the "No tools match" dead end. Three structural defects
// measured on 33 realistic queries + 10 unlock guesses (see README/§recall):
//   1. strict AND-of-OR substring only — one dead token zeroed the whole query
//      (5/33 zero-result, e.g. "抓取网页正文", "search the web for news");
//   2. dev_tool_search matched its OWN description (the capability index lists
//      every keyword), polluting the top-3 of most misses;
//   3. the unlock path only accepted exact names / trailing-* / bare MCP server
//      names, so a typo or shorthand wasted a whole turn.
// Measured on the same corpus (old module + old resolver → now):
//   query path   8/33 empty  → 0/33   (26-28/33 now hit the wanted tool)
//   unlock path  4/10 settled → 9/10  (the last one is ambiguous by design)
//   dead ends    1            → 0
// Now: tiered relaxation (strict AND → any-keyword by hit count → name
// similarity), self-exclusion, and same-call auto-resolution for unambiguous
// near-misses. Ambiguity guards: unique prefix or a clear similarity margin,
// never for MCP names or wildcards; auto-resolved names are always announced.
export { name, inject, apply } from './dev-tool-search.mjs?release=20260930-recall'
