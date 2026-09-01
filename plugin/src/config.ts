// Tunable limits and feature flags for the summary export.

// The generate callback has a 15s budget, so the tree walk, the REST payload
// and the token lookups are all bounded rather than left to run against an
// arbitrarily deep frame.
export const MAX_DEPTH = 18
export const MAX_REST_CHARS = 400000
export const MAX_TOKEN_LOOKUPS = 400
export const MAX_ALIAS_DEPTH = 4

// Figma node ids ("671:2015") mean nothing outside Figma's own data model.
// They are dropped by default; turn this on if you need to map the output back
// into the file programmatically.
export const INCLUDE_NODE_IDS = false

// Prefix the output with a short description of the `colors` / `components`
// conventions, so an agent reading it cold does not have to infer them.
export const INCLUDE_NOTATION = true

// A component only earns its keep if the definition plus its `use` references
// come out meaningfully shorter than the repeated subtrees would have been.
export const MIN_COMPONENT_SAVINGS = 240

// And it stops being a component once nearly everything about it varies: a
// definition behind 60 placeholders is a wall of names, not an abstraction.
// Candidates over the cap are passed over so the smaller, tighter subtrees
// inside them get extracted instead.
export const MAX_COMPONENT_PROPS = 16
