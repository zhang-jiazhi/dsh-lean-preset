// A new module URL lets a new standing mount bypass earlier ESM cache entries.
// 20260922-214500: dead-index cleanup. Removed never-registered names
// (sidebar_open / terminal_* family / dev_config_effective), renamed cordis_*
// to the real 0.1.7 registrations (cordis_inspect_list / cordis_inspect_query),
// completed the memory family (memory_get / memory_runtime). Same-path edits
// stay ESM-cached for the life of the host, so the lean.patch.yml row now
// points at this entry instead of dev-tool-search.mjs directly.
export { name, inject, apply } from './dev-tool-search.mjs?release=20260922-214500'
