// Ties the extract + refine phases together into the two codegen outputs.
import { JsonObject, isObject } from './types'
import { MAX_REST_CHARS, INCLUDE_NOTATION } from './config'
import { extractNode } from './extract/walk'
import { resolveColorTokens } from './refine/tokens'
import { dropDerivableSizes } from './refine/sizes'
import { extractComponents } from './refine/components'
import { stripNodeIds, orderKeys, notation } from './refine/polish'

export async function summaryJson(node: SceneNode): Promise<string> {
  // 1. EXTRACT: the scene graph, as-is.
  const extracted = extractNode(node, 0, 'NONE')

  // 2. REFINE: passes in order, each one narrowing what has to be read.
  const tokenized = await resolveColorTokens(extracted)
  const sized = dropDerivableSizes(tokenized.tree)
  // Every pass maps objects to objects; the guard is only here for the type.
  const componentized = extractComponents(isObject(sized) ? sized : extracted)
  const stripped = stripNodeIds(componentized.tree)

  const output: JsonObject = {}
  if (INCLUDE_NOTATION) {
    const notes = notation(tokenized.colors, componentized.components)
    if (notes !== undefined) output.notation = notes
  }
  if (Object.keys(tokenized.colors).length > 0) output.colors = tokenized.colors
  if (Object.keys(componentized.components).length > 0) output.components = componentized.components
  output.nodes = [stripped]

  return JSON.stringify(orderKeys(output), null, 2)
}

export async function restJson(node: SceneNode): Promise<string> {
  if (!('exportAsync' in node)) {
    return '{\n  "error": "This node type cannot be exported."\n}'
  }

  const exported = (await node.exportAsync({ format: 'JSON_REST_V1' })) as unknown
  const text = JSON.stringify(exported, null, 2)

  if (text.length > MAX_REST_CHARS) {
    return (
      '{\n  "error": "Export is ' +
      String(text.length) +
      ' characters, too large to display here. Select a smaller layer."\n}'
    )
  }

  return text
}
