// Dev Mode codegen plugin: renders the inspected layer as JSON in the Inspect
// panel. The language dropdown (`codegenLanguages` in manifest.json) picks
// between this plugin's AI-oriented summary and Figma's own REST-shaped export.
//
// The summary (see `serialize.ts`) runs in two phases:
//
//   EXTRACT  Walk the Figma scene graph once into a plain JSON tree
//            (`extract/walk.ts`). Anything that needs an async API call to
//            name — colour variables, paint styles — is left behind as a
//            `$token` marker, because the walk itself has to stay synchronous.
//
//   REFINE   Run ordered passes over that tree (`refine/*.ts`), each one
//            paying for itself in what an AI agent no longer has to read:
//              1. resolveColorTokens  markers → named tokens + a `colors` map
//              2. dropDerivableSizes  width/height an agent can infer → gone
//              3. extractComponents   repeated subtrees → `use` + `props`
//              4. stripNodeIds        Figma's opaque ids → gone
//              5. orderKeys           one canonical key order per node
//
// Keys beginning with `$` are hints passed between the two phases and never
// survive into the output. Tunable limits and feature flags live in `config.ts`.
import { summaryJson, restJson } from './serialize'

figma.codegen.on('generate', async (event) => {
  try {
    if (event.language === 'rest') {
      return [{ title: 'Figma REST JSON', language: 'JSON', code: await restJson(event.node) }]
    }
    return [{ title: 'Design JSON', language: 'JSON', code: await summaryJson(event.node) }]
  } catch (error) {
    return [
      {
        title: 'Error',
        language: 'JSON',
        code: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2),
      },
    ]
  }
})
