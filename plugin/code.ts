// Dev Mode codegen plugin: renders the inspected layer as JSON in the Inspect
// panel. The language dropdown picks between this plugin's AI-oriented summary
// and Figma's own REST-shaped export.
//
// The summary runs in two phases:
//
//   EXTRACT  Walk the Figma scene graph once into a plain JSON tree
//            (`extractNode`). Anything that needs an async API call to name —
//            colour variables, paint styles — is left behind as a `$token`
//            marker, because the walk itself has to stay synchronous.
//
//   REFINE   Run ordered passes over that tree, each one paying for itself in
//            what an AI agent no longer has to read:
//              1. resolveColorTokens  markers → named tokens + a `colors` map
//              2. dropDerivableSizes  width/height an agent can infer → gone
//              3. extractComponents   repeated subtrees → `use` + `props`
//              4. stripNodeIds        Figma's opaque ids → gone
//              5. orderKeys           one canonical key order per node
//
// Keys beginning with `$` are hints passed between the two phases and never
// survive into the output.
/// <reference types="@figma/plugin-typings" />

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

// ============================== knobs ==============================

// The generate callback has a 15s budget, so the tree walk, the REST payload
// and the token lookups are all bounded rather than left to run against an
// arbitrarily deep frame.
const MAX_DEPTH = 18
const MAX_REST_CHARS = 400000
const MAX_TOKEN_LOOKUPS = 400
const MAX_ALIAS_DEPTH = 4

// Figma node ids ("671:2015") mean nothing outside Figma's own data model.
// They are dropped by default; turn this on if you need to map the output back
// into the file programmatically.
const INCLUDE_NODE_IDS = false

// Prefix the output with a short description of the `colors` / `components`
// conventions, so an agent reading it cold does not have to infer them.
const INCLUDE_NOTATION = true

// A component only earns its keep if the definition plus its `use` references
// come out meaningfully shorter than the repeated subtrees would have been.
const MIN_COMPONENT_SAVINGS = 240

// And it stops being a component once nearly everything about it varies: a
// definition behind 60 placeholders is a wall of names, not an abstraction.
// Candidates over the cap are passed over so the smaller, tighter subtrees
// inside them get extracted instead.
const MAX_COMPONENT_PROPS = 16

// ============================== helpers ==============================

function isMixed(value: unknown): boolean {
  return value === figma.mixed
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scale(value: number): number {
  if (typeof value !== 'number' || !isFinite(value)) return 0
  const prefs = figma.codegen.preferences
  const factor = prefs.unit === 'SCALED' && prefs.scaleFactor ? prefs.scaleFactor : 1
  return Math.round(value * factor * 100) / 100
}

function round(value: number, places: number): number {
  const f = Math.pow(10, places)
  return Math.round(value * f) / f
}

function toHexByte(channel: number): string {
  const v = Math.max(0, Math.min(255, Math.round(channel * 255)))
  return v.toString(16).padStart(2, '0').toUpperCase()
}

function rgbToHex(color: RGB): string {
  return '#' + toHexByte(color.r) + toHexByte(color.g) + toHexByte(color.b)
}

// Returns 6-digit hex when fully opaque, 8-digit hex with alpha folded in otherwise
function rgbaToHex(color: RGB, opacity: number): string {
  if (Math.round(opacity * 255) === 255) return rgbToHex(color)
  return '#' + toHexByte(color.r) + toHexByte(color.g) + toHexByte(color.b) + toHexByte(opacity)
}

function toSnakeCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'node'
}

function allocateName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let i = 2
  while (used.has(base + '_' + String(i))) i++
  const name = base + '_' + String(i)
  used.add(name)
  return name
}

// Applies `fn` bottom-up to every object in the tree. Non-objects pass through.
function mapObjects(json: Json, fn: (obj: JsonObject) => JsonObject): Json {
  if (Array.isArray(json)) return json.map((item) => mapObjects(item, fn))
  if (!isObject(json)) return json
  const next: JsonObject = {}
  for (const key of Object.keys(json)) next[key] = mapObjects(json[key], fn)
  return fn(next)
}

// ========================= phase 1: extract =========================

// A colour that comes from a variable or a paint style has a name an agent can
// reason about ("Colors/Slate/900" beats "#0F172A"), but reading that name is
// async. The walk records the binding as a marker; `resolveColorTokens` swaps
// in the name afterwards.
interface TokenMarker extends JsonObject {
  $token: 'VARIABLE' | 'STYLE'
  $id: string
  $literal: Json // used verbatim if the lookup fails
}

function isTokenMarker(value: Json | undefined): value is TokenMarker {
  return isObject(value) && typeof value.$token === 'string' && typeof value.$id === 'string'
}

function markerKey(marker: TokenMarker): string {
  return marker.$token + ':' + marker.$id
}

function paintToJson(paint: Paint): Json {
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
function solidToJson(paint: SolidPaint, nodeVariableId: string | undefined, styleId: string | undefined): Json {
  const hex = rgbaToHex(paint.color, paint.opacity ?? 1)
  const variableId = paint.boundVariables?.color?.id ?? nodeVariableId
  if (variableId) return { $token: 'VARIABLE', $id: variableId, $literal: hex }
  if (styleId) return { $token: 'STYLE', $id: styleId, $literal: hex }
  return hex
}

// node.boundVariables.fills / .strokes is a per-paint array, indexed the same
// way as the paint list itself.
function paintVariableIds(node: SceneNode, field: 'fills' | 'strokes'): readonly VariableAlias[] {
  const bound = (node as unknown as { boundVariables?: { [key: string]: unknown } }).boundVariables
  const list = bound ? bound[field] : undefined
  return Array.isArray(list) ? (list as VariableAlias[]) : []
}

function paintStyleId(node: SceneNode, field: 'fills' | 'strokes'): string | undefined {
  const key = field === 'fills' ? 'fillStyleId' : 'strokeStyleId'
  if (!(key in node)) return undefined
  const value = (node as unknown as { [key: string]: unknown })[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

// Visible paints, paired with their index in the original array so that
// per-paint variable bindings still line up after invisible ones are dropped.
function visiblePaints(value: unknown): { paint: Paint; index: number }[] | undefined {
  if (value === undefined || isMixed(value)) return undefined
  const paints = (value as readonly Paint[])
    .map((paint, index) => ({ paint, index }))
    .filter((entry) => entry.paint.visible !== false)
  return paints.length > 0 ? paints : undefined
}

// Single solid paint → scalar key; gradients or multiple paints → array key
function resolvePaints(
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

type SizingMode = 'FIXED' | 'HUG' | 'FILL'

interface Sizing {
  horizontal: SizingMode
  vertical: SizingMode
}

// `layoutSizingHorizontal` / `layoutSizingVertical` only apply to auto-layout
// frames, their children and text nodes, so this asks only where it makes
// sense and falls back to `textAutoResize` for standalone text.
function sizingOf(node: SceneNode, inAutoLayout: boolean): Sizing | undefined {
  const isAutoLayoutFrame =
    'layoutMode' in node && (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL')

  if (isAutoLayoutFrame || inAutoLayout || node.type === 'TEXT') {
    try {
      const sizes = node as unknown as {
        layoutSizingHorizontal?: SizingMode
        layoutSizingVertical?: SizingMode
      }
      if (sizes.layoutSizingHorizontal && sizes.layoutSizingVertical) {
        return { horizontal: sizes.layoutSizingHorizontal, vertical: sizes.layoutSizingVertical }
      }
    } catch {
      // Not an auto-layout participant after all — fall through.
    }
  }

  if (node.type === 'TEXT') {
    if (node.textAutoResize === 'WIDTH_AND_HEIGHT') return { horizontal: 'HUG', vertical: 'HUG' }
    if (node.textAutoResize === 'HEIGHT') return { horizontal: 'FIXED', vertical: 'HUG' }
    return { horizontal: 'FIXED', vertical: 'FIXED' }
  }

  return undefined
}

// `layout` answers two questions: how this node arranges its children (only
// for auto-layout frames) and how it sizes itself (wherever Figma knows).
function layoutToJson(node: SceneNode, sizing: Sizing | undefined): Json | undefined {
  const layout: JsonObject = {}

  if ('layoutMode' in node && (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL')) {
    const frame = node as FrameNode
    layout.mode = frame.layoutMode === 'HORIZONTAL' ? 'row' : 'column'

    // Omit defaults to reduce noise
    const gap = scale(frame.itemSpacing)
    if (gap !== 0) layout.gap = gap

    const pt = scale(frame.paddingTop)
    const pr = scale(frame.paddingRight)
    const pb = scale(frame.paddingBottom)
    const pl = scale(frame.paddingLeft)
    if (pt !== 0 || pr !== 0 || pb !== 0 || pl !== 0) {
      const padding: JsonObject = {}
      if (pt !== 0) padding.top = pt
      if (pr !== 0) padding.right = pr
      if (pb !== 0) padding.bottom = pb
      if (pl !== 0) padding.left = pl
      layout.padding = padding
    }

    if (frame.primaryAxisAlignItems !== 'MIN') layout.primaryAxisAlign = frame.primaryAxisAlignItems
    if (frame.counterAxisAlignItems !== 'MIN') layout.counterAxisAlign = frame.counterAxisAlignItems
    if (frame.layoutWrap === 'WRAP') layout.wrap = true
  }

  if (sizing !== undefined) layout.sizing = { horizontal: sizing.horizontal, vertical: sizing.vertical }

  return Object.keys(layout).length > 0 ? layout : undefined
}

function constraintsToJson(node: SceneNode): Json | undefined {
  if (!('constraints' in node)) return undefined
  const c = (node as unknown as { constraints: { horizontal: string; vertical: string } }).constraints
  if (!c) return undefined
  // MIN/MIN is Figma's default: it says nothing the absence of the key does not.
  if (c.horizontal === 'MIN' && c.vertical === 'MIN') return undefined
  return { horizontal: c.horizontal, vertical: c.vertical }
}

function effectToJson(effect: Effect): Json | null {
  if ((effect as { visible?: boolean }).visible === false) return null
  if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
    const s = effect as DropShadowEffect | InnerShadowEffect
    const result: JsonObject = {
      type: s.type,
      // RGBA shadow colour: fold alpha into 8-digit hex
      color: '#' + toHexByte(s.color.r) + toHexByte(s.color.g) + toHexByte(s.color.b) + toHexByte(s.color.a),
      offset: { x: round(s.offset.x, 2), y: round(s.offset.y, 2) },
      radius: round(s.radius, 2),
    }
    if (s.spread != null && s.spread !== 0) result.spread = round(s.spread, 2)
    return result
  }
  if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
    return { type: effect.type, radius: round(effect.radius, 2) }
  }
  return { type: effect.type }
}

function effectsToJson(effects: readonly Effect[]): Json | undefined {
  const result = effects.map(effectToJson).filter((e): e is NonNullable<typeof e> => e !== null)
  return result.length > 0 ? result : undefined
}

function lineHeightToJson(lh: LineHeight): Json {
  if (lh.unit === 'AUTO') return 'AUTO'
  if (lh.unit === 'PERCENT') return String(round(lh.value, 2)) + '%'
  return round(lh.value, 2) // PIXELS → plain number
}

// Builds the `font` object shared by the node level and mixed-style segments
function buildFont(fontName: unknown, fontSize: unknown, lineHeight: unknown, letterSpacing: unknown): JsonObject {
  const font: JsonObject = {}
  font.family = isMixed(fontName) ? 'MIXED' : (fontName as FontName).family
  const style = isMixed(fontName) ? '' : (fontName as FontName).style
  if (style && style !== 'Regular') font.style = style
  font.size = isMixed(fontSize) ? 'MIXED' : scale(fontSize as number)
  if (!isMixed(lineHeight)) font.lineHeight = lineHeightToJson(lineHeight as LineHeight)
  if (!isMixed(letterSpacing)) {
    const ls = letterSpacing as LetterSpacing
    if (ls.value !== 0) font.letterSpacing = round(ls.value, 3)
  }
  return font
}

// Flattens text properties directly onto the node JSON object
function addTextProps(node: TextNode, json: JsonObject): void {
  json.characters = node.characters
  json.font = buildFont(node.fontName, node.fontSize, node.lineHeight, node.letterSpacing)

  // Alignment: emit only non-default axes (default: LEFT / TOP)
  const align: JsonObject = {}
  if (node.textAlignHorizontal !== 'LEFT') align.horizontal = node.textAlignHorizontal
  if (node.textAlignVertical !== 'TOP') align.vertical = node.textAlignVertical
  if (Object.keys(align).length > 0) json.align = align

  // Mixed-style runs: only emit when more than one segment exists
  try {
    const segs = node.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'lineHeight', 'letterSpacing'])
    if (segs.length > 1) {
      json.segments = segs.map((seg) => {
        const segJson: JsonObject = {
          characters: seg.characters,
          font: buildFont(seg.fontName, seg.fontSize, seg.lineHeight, seg.letterSpacing),
        }
        const segFills = visiblePaints(seg.fills)
        if (segFills && segFills.length === 1 && segFills[0].paint.type === 'SOLID') {
          segJson.color = solidToJson(segFills[0].paint as SolidPaint, undefined, undefined)
        }
        return segJson
      })
    }
  } catch {
    // getStyledTextSegments may not be available in all plugin contexts
  }
}

function cornerRadiusToJson(node: SceneNode): Json | undefined {
  if (!('cornerRadius' in node)) return undefined
  const cr = node.cornerRadius
  if (cr === undefined) return undefined
  if (isMixed(cr)) {
    const f = node as FrameNode
    const obj: JsonObject = {}
    const tl = scale(f.topLeftRadius)
    const tr = scale(f.topRightRadius)
    const br = scale(f.bottomRightRadius)
    const bl = scale(f.bottomLeftRadius)
    if (tl !== 0) obj.topLeftRadius = tl
    if (tr !== 0) obj.topRightRadius = tr
    if (br !== 0) obj.bottomRightRadius = br
    if (bl !== 0) obj.bottomLeftRadius = bl
    return Object.keys(obj).length > 0 ? obj : undefined
  }
  const r = scale(cr as number)
  return r !== 0 ? r : undefined
}

function extractNode(node: SceneNode, depth: number, parentLayout: 'NONE' | 'HORIZONTAL' | 'VERTICAL'): JsonObject {
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

// ================ refine 1: colour tokens → `colors` map ================

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

async function resolveColorTokens(tree: Json): Promise<{ tree: Json; colors: JsonObject }> {
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

// ==================== refine 2: derivable sizes ====================

// Width and height an agent can work out for itself are noise:
//   HUG   → sized by its own content
//   FILL  → sized by its parent
//   GROUP → exactly the bounding box of its children
// What survives is the geometry that carries information: fixed frames and
// leaf shapes such as vectors and rectangles.
function dropDerivableSizes(json: Json): Json {
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

// =================== refine 3: component extraction ===================

// Nodes can share a component definition only when their whole shape matches —
// same type, property set and children, all the way down. That leaves values as
// the only thing free to differ, and those become the props.
//
// Layer names are deliberately *not* part of the shape below the group root:
// duplicated rows and overridden instances routinely differ in layer name while
// being structurally identical, and a differing name is just another prop.
const signatures = new Map<JsonObject, string>()

function signature(node: JsonObject): string {
  const cached = signatures.get(node)
  if (cached !== undefined) return cached

  const keys = Object.keys(node)
    .filter((key) => key !== 'id')
    .sort()
  const childSig = Array.isArray(node.children)
    ? node.children.map((child) => (isObject(child) ? signature(child) : '?')).join(',')
    : ''
  const sig = String(node.type) + '|' + keys.join(',') + '(' + childSig + ')'
  signatures.set(node, sig)
  return sig
}

// The root's name does count: it is what the component ends up being called,
// and merging a "Row" with a "Header" of the same shape would read as a lie.
function groupKey(node: JsonObject): string {
  return String(node.name) + '|' + signature(node)
}

interface NodeGroup {
  depth: number
  nodes: JsonObject[]
}

// depth 0 is the selected node itself, which is never replaced by a reference.
function collectGroups(node: JsonObject, depth: number, groups: Map<string, NodeGroup>): void {
  if (depth > 0 && typeof node.name === 'string' && typeof node.type === 'string') {
    const key = groupKey(node)
    const group = groups.get(key)
    if (group) group.nodes.push(node)
    else groups.set(key, { depth, nodes: [node] })
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) if (isObject(child)) collectGroups(child, depth + 1, groups)
  }
}

// Props are named after the node and property they fill — `investors_characters`,
// `vector_size` — so the props list reads as a description of what varies.
interface PropSlot {
  name: string
  key: string
}

// Content first, geometry last.
const PROP_ORDER = [
  'characters',
  'color',
  'fill',
  'fills',
  'stroke',
  'strokes',
  'strokeWeight',
  'font',
  'align',
  'segments',
  'effects',
  'cornerRadius',
  'opacity',
  'visible',
  'layout',
  'constraints',
  'size',
  'position',
  'children',
]

function propRank(key: string): number {
  const index = PROP_ORDER.indexOf(key)
  return index === -1 ? PROP_ORDER.length : index
}

interface BuiltComponent {
  node: Json
  props: string[]
  instanceProps: JsonObject[]
}

// Walks the whole group in lockstep. A property with the same value on every
// member stays literal in the definition — that is what keeps concrete values
// visible — while one that varies becomes a `{{slot}}` plus a value per member.
function buildTemplate(
  nodes: JsonObject[],
  used: Set<string>,
  slots: PropSlot[],
  instanceProps: JsonObject[],
): JsonObject {
  const first = nodes[0]
  const template: JsonObject = {}
  const nodeName = typeof first.name === 'string' ? first.name : 'node'

  for (const key of Object.keys(first)) {
    if (key === 'id') continue // unique per node by definition
    if (key === 'children' && Array.isArray(first.children)) continue // recursed below

    const values = nodes.map((node) => node[key])
    const encoded = values.map((value) => JSON.stringify(value))
    if (encoded.every((value) => value === encoded[0])) {
      template[key] = values[0]
      continue
    }

    const name = allocateName(toSnakeCase(nodeName) + '_' + toSnakeCase(key), used)
    slots.push({ name, key })
    values.forEach((value, index) => {
      instanceProps[index][name] = value === undefined ? null : value
    })
    template[key] = '{{' + name + '}}'
  }

  if (Array.isArray(first.children)) {
    template.children = first.children.map((child, index) => {
      if (!isObject(child)) return child
      const peers = nodes.map((node) => {
        const children = node.children
        const peer = Array.isArray(children) ? children[index] : undefined
        return isObject(peer) ? peer : child
      })
      return buildTemplate(peers, used, slots, instanceProps)
    })
  }

  return template
}

function buildComponent(nodes: JsonObject[]): BuiltComponent {
  const used = new Set<string>()
  const slots: PropSlot[] = []
  const instanceProps: JsonObject[] = nodes.map(() => ({}))
  const template = buildTemplate(nodes, used, slots, instanceProps)

  slots.sort((a, b) => propRank(a.key) - propRank(b.key) || a.name.localeCompare(b.name))
  return { node: template, props: slots.map((slot) => slot.name), instanceProps }
}

// Indirection is only worth it if it buys back more than it costs to explain.
function worthExtracting(nodes: JsonObject[], built: BuiltComponent, references: Json[]): boolean {
  const inline = nodes.reduce<number>((total, node) => total + JSON.stringify(node).length, 0)
  const extracted =
    JSON.stringify({ node: built.node, props: built.props }).length +
    references.reduce<number>((total, reference) => total + JSON.stringify(reference).length, 0)
  return inline - extracted >= MIN_COMPONENT_SAVINGS
}

function markSubtree(node: JsonObject, claimed: Set<JsonObject>): void {
  claimed.add(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) if (isObject(child)) markSubtree(child, claimed)
  }
}

function applyReplacements(node: JsonObject, replacements: Map<JsonObject, Json>, isRoot: boolean): Json {
  if (!isRoot) {
    const replacement = replacements.get(node)
    if (replacement !== undefined) return replacement
  }
  if (!Array.isArray(node.children)) return node
  return {
    ...node,
    children: node.children.map((child) =>
      isObject(child) ? applyReplacements(child, replacements, false) : child,
    ),
  }
}

function extractComponents(tree: JsonObject): { tree: Json; components: JsonObject } {
  signatures.clear()
  const groups = new Map<string, NodeGroup>()
  collectGroups(tree, 0, groups)

  // Outermost first: once a subtree is lifted out, everything inside it is
  // either part of the definition or hidden behind a reference, so a deeper
  // group that straddles it could no longer be resolved.
  const candidates = Array.from(groups.values())
    .filter((group) => group.nodes.length > 1)
    .sort((a, b) => a.depth - b.depth || b.nodes.length - a.nodes.length)

  const components: JsonObject = {}
  const replacements = new Map<JsonObject, Json>()
  const claimed = new Set<JsonObject>()
  const usedNames = new Set<string>()

  for (const group of candidates) {
    if (group.nodes.some((node) => claimed.has(node))) continue

    const built = buildComponent(group.nodes)
    if (built.props.length > MAX_COMPONENT_PROPS) continue

    // Named before the size check so that check weighs the real references.
    const baseName = typeof group.nodes[0].name === 'string' ? group.nodes[0].name : 'Component'
    let displayName = baseName
    if (usedNames.has(displayName)) {
      let n = 2
      while (usedNames.has(baseName + String(n))) n++
      displayName = baseName + String(n)
    }

    const references: JsonObject[] = group.nodes.map((node, index) => {
      const reference: JsonObject = {}
      if (INCLUDE_NODE_IDS && typeof node.id === 'string') reference.id = node.id
      reference.use = displayName
      if (built.props.length > 0) reference.props = built.instanceProps[index]
      return reference
    })
    if (!worthExtracting(group.nodes, built, references)) continue

    usedNames.add(displayName)
    components[displayName] = { node: built.node, props: built.props }
    group.nodes.forEach((node, index) => {
      replacements.set(node, references[index])
      markSubtree(node, claimed)
    })
  }

  return { tree: applyReplacements(tree, replacements, true), components }
}

// ======================= refine 4 & 5: polish =======================

function stripNodeIds(json: Json): Json {
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

function orderKeys(json: Json): Json {
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
function notation(colors: JsonObject, components: JsonObject): Json | undefined {
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

// ============================ entry points ============================

async function summaryJson(node: SceneNode): Promise<string> {
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

async function restJson(node: SceneNode): Promise<string> {
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
