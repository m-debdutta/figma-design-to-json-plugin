// Auto-layout, sizing, constraints and corner-radius → JSON.
import { Json, JsonObject, isMixed } from '../types'
import { scale } from '../format'

export type SizingMode = 'FIXED' | 'HUG' | 'FILL'

export interface Sizing {
  horizontal: SizingMode
  vertical: SizingMode
}

// `layoutSizingHorizontal` / `layoutSizingVertical` only apply to auto-layout
// frames, their children and text nodes, so this asks only where it makes
// sense and falls back to `textAutoResize` for standalone text.
export function sizingOf(node: SceneNode, inAutoLayout: boolean): Sizing | undefined {
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
export function layoutToJson(node: SceneNode, sizing: Sizing | undefined): Json | undefined {
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

export function constraintsToJson(node: SceneNode): Json | undefined {
  if (!('constraints' in node)) return undefined
  const c = (node as unknown as { constraints: { horizontal: string; vertical: string } }).constraints
  if (!c) return undefined
  // MIN/MIN is Figma's default: it says nothing the absence of the key does not.
  if (c.horizontal === 'MIN' && c.vertical === 'MIN') return undefined
  return { horizontal: c.horizontal, vertical: c.vertical }
}

export function cornerRadiusToJson(node: SceneNode): Json | undefined {
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
