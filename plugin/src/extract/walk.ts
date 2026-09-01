// Phase 1 (EXTRACT): walks the scene graph once into a plain JSON tree.
import { JsonObject, isMixed } from '../types'
import { MAX_DEPTH } from '../config'
import { scale, round } from '../format'
import { resolvePaints } from './paint'
import { constraintsToJson, cornerRadiusToJson, layoutToJson, sizingOf } from './layout'
import { effectsToJson } from './effects'
import { addTextProps } from './text'

export function extractNode(node: SceneNode, depth: number, parentLayout: 'NONE' | 'HORIZONTAL' | 'VERTICAL'): JsonObject {
  const json: JsonObject = {
    id: node.id,
    name: node.name,
    type: node.type,
  }

  if (node.visible === false) json.visible = false

  if ('width' in node && 'height' in node) {
    json.size = { width: scale(node.width), height: scale(node.height) }
  }

  const inAutoLayout = parentLayout !== 'NONE'
  const absolute =
    !inAutoLayout || ('layoutPositioning' in node && node.layoutPositioning === 'ABSOLUTE')

  // Where auto-layout is not doing the arranging, the offset from the parent is
  // the only thing that says where this node actually sits.
  if (absolute && depth > 0 && 'x' in node && 'y' in node) {
    const x = scale(node.x)
    const y = scale(node.y)
    if (x !== 0 || y !== 0) json.position = { x, y }
  }

  if ('opacity' in node && node.opacity !== 1) {
    json.opacity = round(node.opacity, 2)
  }

  const cornerRadius = cornerRadiusToJson(node)
  if (cornerRadius !== undefined) json.cornerRadius = cornerRadius

  // Fills: TEXT nodes express a single fill as `color`; everything else as `fill`
  const fills = resolvePaints(node, 'fills')
  if (fills !== undefined) {
    if (fills.plural) json.fills = fills.value
    else if (node.type === 'TEXT') json.color = fills.value
    else json.fill = fills.value
  }

  const strokes = resolvePaints(node, 'strokes')
  if (strokes !== undefined) {
    if (strokes.plural) json.strokes = strokes.value
    else json.stroke = strokes.value
    const sw = (node as unknown as { strokeWeight?: unknown }).strokeWeight
    if (!isMixed(sw) && typeof sw === 'number' && sw !== 0) json.strokeWeight = scale(sw)
  }

  const constraints = constraintsToJson(node)
  if (constraints !== undefined) json.constraints = constraints

  if ('effects' in node && node.effects.length > 0) {
    const effects = effectsToJson(node.effects)
    if (effects !== undefined) json.effects = effects
  }

  // Text: flatten characters / font / align / segments onto the node
  if (node.type === 'TEXT') addTextProps(node, json)

  const layout = layoutToJson(node, sizingOf(node, inAutoLayout))
  if (layout !== undefined) json.layout = layout

  if ('children' in node && node.children.length > 0) {
    if (depth >= MAX_DEPTH) {
      json.children = 'TRUNCATED: ' + String(node.children.length) + ' more children'
    } else {
      const childLayout =
        'layoutMode' in node && (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL')
          ? node.layoutMode
          : 'NONE'
      json.children = node.children.map((child) => extractNode(child, depth + 1, childLayout))
    }
  }

  return json
}
