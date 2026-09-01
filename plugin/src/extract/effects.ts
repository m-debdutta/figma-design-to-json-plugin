// Shadow/blur effects → JSON.
import { Json, JsonObject } from '../types'
import { round, toHexByte } from '../format'

export function effectToJson(effect: Effect): Json | null {
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

export function effectsToJson(effects: readonly Effect[]): Json | undefined {
  const result = effects.map(effectToJson).filter((e): e is NonNullable<typeof e> => e !== null)
  return result.length > 0 ? result : undefined
}
