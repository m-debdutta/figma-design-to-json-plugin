// Dev Mode codegen plugin: emits a JSON representation of the inspected node
// in the Inspect panel. The language dropdown chooses between a compact
// hand-built summary and Figma's full REST-shaped export.
/// <reference types="@figma/plugin-typings" />

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

// The generate callback has a 15s timeout, so both the tree walk and the REST
// payload are bounded rather than left to run against arbitrarily deep frames.
const MAX_DEPTH = 12
const MAX_REST_CHARS = 400000

function isMixed(value: unknown): boolean {
  return value === figma.mixed
}

function scale(value: number): number {
  if (typeof value !== 'number' || !isFinite(value)) {
    return 0
  }

  const prefs = figma.codegen.preferences
  const factor =
    prefs.unit === 'SCALED' && prefs.scaleFactor ? prefs.scaleFactor : 1

  return Math.round(value * factor * 100) / 100
}

function toHex(channel: number): string {
  const v = Math.max(0, Math.min(255, Math.round(channel * 255)))

  return v.toString(16).padStart(2, '0')
}

function colorToHex(color: RGB): string {
  return '#' + toHex(color.r) + toHex(color.g) + toHex(color.b)
}

function paintToJson(paint: Paint): Json {
  if (paint.type === 'SOLID') {
    return {
      type: paint.type,
      color: colorToHex(paint.color),
      opacity: paint.opacity === undefined ? 1 : Math.round(paint.opacity * 100) / 100,
    }
  }

  if (
    paint.type === 'GRADIENT_LINEAR' ||
    paint.type === 'GRADIENT_RADIAL' ||
    paint.type === 'GRADIENT_ANGULAR' ||
    paint.type === 'GRADIENT_DIAMOND'
  ) {
    return {
      type: paint.type,
      stops: paint.gradientStops.map((stop) => ({
        position: Math.round(stop.position * 100) / 100,
        color: colorToHex(stop.color),
      })),
    }
  }

  return { type: paint.type }
}

function paintsToJson(value: unknown): Json | undefined {
  if (value === undefined) {
    return undefined
  }

  if (isMixed(value)) {
    return 'MIXED'
  }

  const paints = (value as readonly Paint[]).filter((p) => p.visible !== false)

  return paints.length > 0 ? paints.map(paintToJson) : undefined
}

function autoLayoutToJson(node: FrameNode | ComponentNode | InstanceNode): Json | undefined {
  if (node.layoutMode !== 'HORIZONTAL' && node.layoutMode !== 'VERTICAL') {
    return undefined
  }

  return {
    direction: node.layoutMode,
    gap: scale(node.itemSpacing),
    padding: {
      top: scale(node.paddingTop),
      right: scale(node.paddingRight),
      bottom: scale(node.paddingBottom),
      left: scale(node.paddingLeft),
    },
    primaryAxisAlign: node.primaryAxisAlignItems,
    counterAxisAlign: node.counterAxisAlignItems,
  }
}

function textToJson(node: TextNode): Json {
  const fontName = node.fontName
  const fontSize = node.fontSize
  const lineHeight = node.lineHeight

  const text: { [key: string]: Json } = {
    characters: node.characters,
    align: node.textAlignHorizontal,
  }

  text.fontFamily = isMixed(fontName) ? 'MIXED' : (fontName as FontName).family
  text.fontStyle = isMixed(fontName) ? 'MIXED' : (fontName as FontName).style
  text.fontSize = isMixed(fontSize) ? 'MIXED' : scale(fontSize as number)

  if (!isMixed(lineHeight)) {
    const lh = lineHeight as LineHeight

    text.lineHeight = lh.unit === 'AUTO' ? 'AUTO' : String(lh.value) + (lh.unit === 'PERCENT' ? '%' : 'px')
  } else {
    text.lineHeight = 'MIXED'
  }

  return text
}

function nodeToJson(node: SceneNode, depth: number): Json {
  const json: { [key: string]: Json } = {
    id: node.id,
    name: node.name,
    type: node.type,
  }

  if (node.visible === false) {
    json.visible = false
  }

  if ('width' in node && 'height' in node) {
    json.size = { width: scale(node.width), height: scale(node.height) }
  }

  if ('opacity' in node && node.opacity !== 1) {
    json.opacity = Math.round(node.opacity * 100) / 100
  }

  if ('cornerRadius' in node && node.cornerRadius !== undefined) {
    json.cornerRadius = isMixed(node.cornerRadius) ? 'MIXED' : scale(node.cornerRadius as number)
  }

  if ('fills' in node) {
    const fills = paintsToJson(node.fills)

    if (fills !== undefined) {
      json.fills = fills
    }
  }

  if ('strokes' in node) {
    const strokes = paintsToJson(node.strokes)

    if (strokes !== undefined) {
      json.strokes = strokes
      json.strokeWeight = isMixed(node.strokeWeight) ? 'MIXED' : scale(node.strokeWeight as number)
    }
  }

  if (node.type === 'TEXT') {
    json.text = textToJson(node)
  }

  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    const layout = autoLayoutToJson(node)

    if (layout !== undefined) {
      json.autoLayout = layout
    }
  }

  if ('children' in node && node.children.length > 0) {
    if (depth >= MAX_DEPTH) {
      json.children = 'TRUNCATED: ' + String(node.children.length) + ' more children'
    } else {
      json.children = node.children.map((child) => nodeToJson(child, depth + 1))
    }
  }

  return json
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
  const node = event.node

  try {
    if (event.language === 'rest') {
      return [
        {
          title: 'Figma REST JSON',
          language: 'JSON',
          code: await restJson(node),
        },
      ]
    }

    return [
      {
        title: 'Design JSON',
        language: 'JSON',
        code: JSON.stringify(nodeToJson(node, 0), null, 2),
      },
    ]
  } catch (error) {
    return [
      {
        title: 'Error',
        language: 'JSON',
        code: JSON.stringify(
          { error: error instanceof Error ? error.message : String(error) },
          null,
          2,
        ),
      },
    ]
  }
})
