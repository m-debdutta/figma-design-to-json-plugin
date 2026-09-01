// Number, colour and naming formatting helpers shared by the extract/refine passes.

export function scale(value: number): number {
  if (typeof value !== 'number' || !isFinite(value)) return 0
  const prefs = figma.codegen.preferences
  const factor = prefs.unit === 'SCALED' && prefs.scaleFactor ? prefs.scaleFactor : 1
  return Math.round(value * factor * 100) / 100
}

export function round(value: number, places: number): number {
  const f = Math.pow(10, places)
  return Math.round(value * f) / f
}

export function toHexByte(channel: number): string {
  const v = Math.max(0, Math.min(255, Math.round(channel * 255)))
  return v.toString(16).padStart(2, '0').toUpperCase()
}

export function rgbToHex(color: RGB): string {
  return '#' + toHexByte(color.r) + toHexByte(color.g) + toHexByte(color.b)
}

// Returns 6-digit hex when fully opaque, 8-digit hex with alpha folded in otherwise
export function rgbaToHex(color: RGB, opacity: number): string {
  if (Math.round(opacity * 255) === 255) return rgbToHex(color)
  return '#' + toHexByte(color.r) + toHexByte(color.g) + toHexByte(color.b) + toHexByte(opacity)
}

export function toSnakeCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'node'
}

export function allocateName(base: string, used: Set<string>): string {
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
