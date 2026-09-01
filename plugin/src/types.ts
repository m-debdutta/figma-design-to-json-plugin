// Shared JSON tree types and small generic helpers used across every phase.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

export function isMixed(value: unknown): boolean {
  return value === figma.mixed
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Applies `fn` bottom-up to every object in the tree. Non-objects pass through.
export function mapObjects(json: Json, fn: (obj: JsonObject) => JsonObject): Json {
  if (Array.isArray(json)) return json.map((item) => mapObjects(item, fn))
  if (!isObject(json)) return json
  const next: JsonObject = {}
  for (const key of Object.keys(json)) next[key] = mapObjects(json[key], fn)
  return fn(next)
}
