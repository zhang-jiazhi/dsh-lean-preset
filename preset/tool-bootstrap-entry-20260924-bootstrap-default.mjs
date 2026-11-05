// Fresh entry PATH, not just a fresh query: Node keys its ESM cache by resolved
// URL, so an edited same-path module keeps serving the old graph for the life of
// the host. Both this path and the versioned re-export URL below are new.
// 20260924-bootstrap-default: `bootstrapTools` was the ONE list key with no
// fallback. `stringList(source.bootstrapTools, ...)` rejected `undefined`, so a
// mount that omitted the key threw `bootstrapTools must be a non-empty array of
// non-empty strings` and the whole row failed — while `DEFAULT_BOOTSTRAP_TOOLS`
// sat right above it as a dead constant, referenced nowhere. Every sibling key
// (`residentTools`, `suppressedContextSources`, `keptContextSources`,
// `bootstrapPersona`) already had a default, so this was an asymmetry, not a
// decision. The fallback is now `?? DEFAULT_BOOTSTRAP_TOOLS`; a present-but-
// invalid value (empty array, empty string, non-array) still throws.
// lean.patch.yml passes its own four-name set, so live behavior is unchanged.
export { name, inject, apply } from './tool-bootstrap.mjs?release=20260924-bootstrap-default'
