// Converts Figma paints (fills/strokes) into JSON, deferring variable/style
// names via `$token` markers since naming them requires an async lookup.
import { Json, JsonObject, isMixed, isObject } from '../types'
import { round, rgbToHex, rgbaToHex } from '../format'

// A colour that comes from a variable or a paint style has a name an agent can
// reason about ("Colors/Slate/900" beats "#0F172A"), but reading that name is
// async. The walk records the binding as a marker; `resolveColorTokens` swaps
// in the name afterwards.
export interface TokenMarker extends JsonObject {
  $token: 'VARIABLE' | 'STYLE'
  $id: string
  $literal: Json // used verbatim if the lookup fails
}

export function isTokenMarker(value: Json | undefined): value is TokenMarker {
  return isObject(value) && typeof value.$token === 'string' && typeof value.$id === 'string'
}

export function markerKey(marker: TokenMarker): string {
  return marker.$token + ':' + marker.$id
}

export function paintToJson(paint: Paint): Json {
  if (paint.type === 'SOLID') {
    return solidToJson(paint, undefined, undefined)
  }
  if (
    paint.type === 'GRADIENT_LINEAR' ||
    paint.type === 'GRADIENT_RADIAL' ||
    paint.type === 'GRADIENT_ANGULAR' ||
    paint.type === 'GRADIENT_DIAMOND'
  ) {
    return {
      gradient: paint.type,
      stops: paint.gradientStops.map((stop) => ({
        position: round(stop.position, 2),
        color: rgbToHex(stop.color),
      })),
    }
  }
  if (paint.type === 'IMAGE') return { image: paint.scaleMode }
  return { type: paint.type }
}

// A solid paint becomes a hex string, or a token marker when its colour is
// driven by a variable (checked on the paint first, then on the node) or by a
// single-colour paint style.
export function solidToJson(paint: SolidPaint, nodeVariableId: string | undefined, styleId: string | undefined): Json {
  const hex = rgbaToHex(paint.color, paint.opacity ?? 1)
  const variableId = paint.boundVariables?.color?.id ?? nodeVariableId
  if (variableId) return { $token: 'VARIABLE', $id: variableId, $literal: hex }
  if (styleId) return { $token: 'STYLE', $id: styleId, $literal: hex }
  return hex
}

// node.boundVariables.fills / .strokes is a per-paint array, indexed the same
// way as the paint list itself.
export function paintVariableIds(node: SceneNode, field: 'fills' | 'strokes'): readonly VariableAlias[] {
  const bound = (node as unknown as { boundVariables?: { [key: string]: unknown } }).boundVariables
  const list = bound ? bound[field] : undefined
  return Array.isArray(list) ? (list as VariableAlias[]) : []
}

export function paintStyleId(node: SceneNode, field: 'fills' | 'strokes'): string | undefined {
  const key = field === 'fills' ? 'fillStyleId' : 'strokeStyleId'
  if (!(key in node)) return undefined
  const value = (node as unknown as { [key: string]: unknown })[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

// Visible paints, paired with their index in the original array so that
// per-paint variable bindings still line up after invisible ones are dropped.
export function visiblePaints(value: unknown): { paint: Paint; index: number }[] | undefined {
  if (value === undefined || isMixed(value)) return undefined
  const paints = (value as readonly Paint[])
    .map((paint, index) => ({ paint, index }))
    .filter((entry) => entry.paint.visible !== false)
  return paints.length > 0 ? paints : undefined
}

// Single solid paint → scalar key; gradients or multiple paints → array key
export function resolvePaints(
  node: SceneNode,
  field: 'fills' | 'strokes',
): { plural: boolean; value: Json } | undefined {
  if (!(field in node)) return undefined
  const paints = visiblePaints((node as unknown as { [key: string]: unknown })[field])
  if (paints === undefined) return undefined

  if (paints.length === 1 && paints[0].paint.type === 'SOLID') {
    const alias = paintVariableIds(node, field)[paints[0].index]
    return {
      plural: false,
      value: solidToJson(paints[0].paint as SolidPaint, alias ? alias.id : undefined, paintStyleId(node, field)),
    }
  }
  return { plural: true, value: paints.map((entry) => paintToJson(entry.paint)) }
}
