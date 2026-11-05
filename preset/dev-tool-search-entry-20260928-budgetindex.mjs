// New entry and import URL bypass cached implementations on new preset revisions.
// 20260928-budgetindex: the capability index renders through a budgeted path
// (per-entry cap + total budget with name-only degradation). Today's index
// fits both budgets, so the rendered description is byte-identical to the
// previous release; the change is a guard against future index growth.
export { name, inject, apply } from './dev-tool-search.mjs?release=20260928-budgetindex'
