// Phase 2 pass: resolves `$token` markers into named colour tokens, producing
// the top-level `colors` map.
import { Json, JsonObject, isObject } from '../types'
import { rgbaToHex } from '../format'
import { MAX_ALIAS_DEPTH, MAX_TOKEN_LOOKUPS } from '../config'
import { TokenMarker, isTokenMarker, markerKey, paintToJson } from '../extract/paint'

interface ResolvedToken {
  name: string
  value: Json
}

function isVariableAlias(value: unknown): value is VariableAlias {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: string }).type === 'VARIABLE_ALIAS'
  )
}

// Variable values can point at other variables. Follow the chain, preferring a
// mode of the same name in the target collection so a "Dark mode" lookup does
// not silently fall back to the target's default mode.
async function resolveColorForMode(
  variable: Variable,
  modeId: string | undefined,
  modeName: string | undefined,
  depth: number,
): Promise<string | null> {
  if (modeId === undefined) return null
  const value = variable.valuesByMode[modeId]
  if (value === undefined) return null

  if (isVariableAlias(value)) {
    if (depth >= MAX_ALIAS_DEPTH) return null
    const target = await figma.variables.getVariableByIdAsync(value.id)
    if (!target) return null
    const collection = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId)
    const sameName = modeName && collection ? collection.modes.find((m) => m.name === modeName) : undefined
    const nextMode = sameName
      ? sameName.modeId
      : collection
        ? collection.defaultModeId
        : Object.keys(target.valuesByMode)[0]
    return resolveColorForMode(target, nextMode, modeName, depth + 1)
  }

  if (typeof value === 'object' && value !== null && 'r' in value) {
    const color = value as RGBA
    return rgbaToHex(color, typeof color.a === 'number' ? color.a : 1)
  }
  return null
}

// One mode → a plain hex string. Several → a hex per mode name, which is how
// light/dark pairs stay visible ({ "Light mode": "#475569", … }).
async function resolveVariableToken(id: string): Promise<ResolvedToken | null> {
  const variable = await figma.variables.getVariableByIdAsync(id)
  if (!variable || variable.resolvedType !== 'COLOR') return null

  const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)
  const modes = collection ? collection.modes : []

  if (modes.length < 2) {
    const modeId = collection ? collection.defaultModeId : Object.keys(variable.valuesByMode)[0]
    const hex = await resolveColorForMode(variable, modeId, undefined, 0)
    return hex === null ? null : { name: variable.name, value: hex }
  }

  const byMode: JsonObject = {}
  for (const mode of modes) {
    const hex = await resolveColorForMode(variable, mode.modeId, mode.name, 0)
    if (hex !== null) byMode[mode.name] = hex
  }

  const names = Object.keys(byMode)
  if (names.length === 0) return null
  // Modes that all agree carry no more information than a single value.
  if (names.every((name) => byMode[name] === byMode[names[0]])) {
    return { name: variable.name, value: byMode[names[0]] }
  }
  return { name: variable.name, value: byMode }
}

async function resolveStyleToken(id: string): Promise<ResolvedToken | null> {
  const style = await figma.getStyleByIdAsync(id)
  if (!style || style.type !== 'PAINT') return null
  const paints = (style as PaintStyle).paints.filter((p) => p.visible !== false)
  if (paints.length === 0) return null
  if (paints.length === 1 && paints[0].type === 'SOLID') {
    const solid = paints[0] as SolidPaint
    return { name: style.name, value: rgbaToHex(solid.color, solid.opacity ?? 1) }
  }
  return { name: style.name, value: paints.map(paintToJson) }
}

async function resolveToken(marker: TokenMarker): Promise<ResolvedToken | null> {
  try {
    if (marker.$token === 'VARIABLE') return await resolveVariableToken(marker.$id)
    return await resolveStyleToken(marker.$id)
  } catch {
    // A missing or inaccessible variable/style just falls back to its literal.
    return null
  }
}

function collectMarkers(json: Json, into: Map<string, TokenMarker>): void {
  if (Array.isArray(json)) {
    for (const item of json) collectMarkers(item, into)
    return
  }
  if (!isObject(json)) return
  if (isTokenMarker(json)) {
    into.set(markerKey(json), json)
    return
  }
  for (const key of Object.keys(json)) collectMarkers(json[key], into)
}

// Replaces every `$token` marker with its token name, or with the literal hex
// it was carrying if the lookup failed.
function applyTokenNames(json: Json, names: Map<string, string>): Json {
  if (Array.isArray(json)) return json.map((item) => applyTokenNames(item, names))
  if (!isObject(json)) return json
  if (isTokenMarker(json)) {
    const name = names.get(markerKey(json))
    return name !== undefined ? name : json.$literal
  }
  const next: JsonObject = {}
  for (const key of Object.keys(json)) next[key] = applyTokenNames(json[key], names)
  return next
}

export async function resolveColorTokens(tree: Json): Promise<{ tree: Json; colors: JsonObject }> {
  const markers = new Map<string, TokenMarker>()
  collectMarkers(tree, markers)

  const keys = Array.from(markers.keys()).slice(0, MAX_TOKEN_LOOKUPS)
  const resolved = await Promise.all(keys.map((key) => resolveToken(markers.get(key) as TokenMarker)))

  const colors: JsonObject = {}
  const names = new Map<string, string>()

  keys.forEach((key, index) => {
    const token = resolved[index]
    if (token === null) return
    // Two collections can hold same-named variables. Reuse the name when the
    // value matches, otherwise disambiguate rather than clobber.
    let name = token.name
    if (Object.prototype.hasOwnProperty.call(colors, name) && JSON.stringify(colors[name]) !== JSON.stringify(token.value)) {
      let n = 2
      while (Object.prototype.hasOwnProperty.call(colors, name + ' (' + String(n) + ')')) n++
      name = name + ' (' + String(n) + ')'
    }
    colors[name] = token.value
    names.set(key, name)
  })

  return { tree: applyTokenNames(tree, names), colors }
}
