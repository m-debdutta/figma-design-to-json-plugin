// Phase 2 passes: strips node ids, orders keys, and builds the notation hint.
import { Json, JsonObject, mapObjects } from '../types'
import { INCLUDE_NODE_IDS } from '../config'

export function stripNodeIds(json: Json): Json {
  if (INCLUDE_NODE_IDS) return json
  return mapObjects(json, (node) => {
    if (typeof node.id === 'string' && typeof node.type === 'string') delete node.id
    return node
  })
}

// One shape for every node: what it is, what it says, how it looks, where it
// sits, then its children — so an agent reads the same order every time.
const KEY_ORDER = [
  'use',
  'props',
  'id',
  'name',
  'type',
  'characters',
  'color',
  'font',
  'align',
  'segments',
  'fill',
  'fills',
  'stroke',
  'strokes',
  'strokeWeight',
  'cornerRadius',
  'effects',
  'opacity',
  'visible',
  'layout',
  'constraints',
  'size',
  'position',
  'children',
]

export function orderKeys(json: Json): Json {
  return mapObjects(json, (node) => {
    const isNode = typeof node.type === 'string' && typeof node.name === 'string'
    const isReference = typeof node.use === 'string'
    if (!isNode && !isReference) return node

    const keys = Object.keys(node)
    const known = KEY_ORDER.filter((key) => keys.indexOf(key) !== -1)
    const rest = keys.filter((key) => KEY_ORDER.indexOf(key) === -1)
    const ordered: JsonObject = {}
    for (const key of known.concat(rest)) ordered[key] = node[key]
    return ordered
  })
}

// The conventions above are only obvious once you already know them.
export function notation(colors: JsonObject, components: JsonObject): Json | undefined {
  const hasColors = Object.keys(colors).length > 0
  const hasComponents = Object.keys(components).length > 0
  if (!hasColors && !hasComponents) return undefined

  const notes: JsonObject = {}
  if (hasComponents) {
    notes.components =
      '{ "use": "X", "props": {…} } is components.X.node with every "{{slot}}" replaced by the matching entry in props.'
  }
  if (hasColors) {
    notes.colors =
      'A fill/stroke/color that is not a #hex value is a key into `colors`. An object there maps one hex per mode.'
  }
  const prefs = figma.codegen.preferences
  notes.units =
    prefs.unit === 'SCALED' && prefs.scaleFactor
      ? 'Lengths are px, scaled ' + String(prefs.scaleFactor) + 'x. Colors are #RRGGBB or #RRGGBBAA.'
      : 'Lengths are px. Colors are #RRGGBB or #RRGGBBAA.'
  return notes
}
