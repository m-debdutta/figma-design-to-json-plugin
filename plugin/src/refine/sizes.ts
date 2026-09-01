// Phase 2 pass: drops width/height values an agent can infer on its own
// (HUG → sized by content, FILL → sized by parent, GROUP → bounding box).
import { Json, isObject, mapObjects } from '../types'

export function dropDerivableSizes(json: Json): Json {
  return mapObjects(json, (node) => {
    if (typeof node.type !== 'string') return node

    const layout = isObject(node.layout) ? { ...node.layout } : undefined
    const sizing = layout && isObject(layout.sizing) ? layout.sizing : undefined
    const size = isObject(node.size) ? { ...node.size } : undefined

    // HUG on both axes is what a text node does by default.
    if (layout && sizing && node.type === 'TEXT' && sizing.horizontal === 'HUG' && sizing.vertical === 'HUG') {
      delete layout.sizing
    }

    if (size !== undefined) {
      if (node.type === 'GROUP') {
        delete node.size
      } else if (sizing !== undefined) {
        if (sizing.horizontal !== 'FIXED') delete size.width
        if (sizing.vertical !== 'FIXED') delete size.height
        if (Object.keys(size).length === 0) delete node.size
        else node.size = size
      }
    }

    // FIXED on both axes says no more than the numbers already do.
    if (layout && sizing && sizing.horizontal === 'FIXED' && sizing.vertical === 'FIXED' && node.size !== undefined) {
      delete layout.sizing
    }
    if (layout !== undefined) {
      if (Object.keys(layout).length === 0) delete node.layout
      else node.layout = layout
    }

    return node
  })
}
