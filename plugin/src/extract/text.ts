// Text-specific properties (characters, font, mixed-style segments) → JSON.
/// <reference types="@figma/plugin-typings" />
import { Json, JsonObject, isMixed } from '../types'
import { scale, round } from '../format'
import { visiblePaints, solidToJson } from './paint'

export function lineHeightToJson(lh: LineHeight): Json {
  if (lh.unit === 'AUTO') return 'AUTO'
  if (lh.unit === 'PERCENT') return String(round(lh.value, 2)) + '%'
  return round(lh.value, 2) // PIXELS → plain number
}

// Builds the `font` object shared by the node level and mixed-style segments
export function buildFont(fontName: unknown, fontSize: unknown, lineHeight: unknown, letterSpacing: unknown): JsonObject {
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
export function addTextProps(node: TextNode, json: JsonObject): void {
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
