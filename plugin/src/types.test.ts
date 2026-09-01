import { beforeEach, describe, expect, it } from 'vitest'
import { installFigmaStub } from './test/figma-stub'
import { isMixed, isObject, mapObjects } from './types'

beforeEach(() => {
  installFigmaStub()
})

describe('isMixed', () => {
  it('is true only for the figma.mixed sentinel', () => {
    expect(isMixed(figma.mixed)).toBe(true)
    expect(isMixed('MIXED')).toBe(false)
    expect(isMixed(undefined)).toBe(false)
  })
})

describe('isObject', () => {
  it('accepts plain objects and rejects arrays, null and scalars', () => {
    expect(isObject({})).toBe(true)
    expect(isObject({ a: 1 })).toBe(true)
    expect(isObject([])).toBe(false)
    expect(isObject(null)).toBe(false)
    expect(isObject(undefined)).toBe(false)
    expect(isObject('x')).toBe(false)
    expect(isObject(1)).toBe(false)
  })
})

describe('mapObjects', () => {
  it('applies fn bottom-up to every object in the tree', () => {
    const order: string[] = []
    const tree = { name: 'root', children: [{ name: 'a' }, { name: 'b' }] }
    mapObjects(tree, (obj) => {
      order.push(String(obj.name))
      return obj
    })
    expect(order).toEqual(['a', 'b', 'root'])
  })

  it('lets fn rewrite each object', () => {
    const tree = { children: [{ value: 1 }, { value: 2 }] }
    const result = mapObjects(tree, (obj) => {
      if (typeof obj.value === 'number') return { ...obj, value: obj.value * 10 }
      return obj
    })
    expect(result).toEqual({ children: [{ value: 10 }, { value: 20 }] })
  })

  it('passes arrays and scalars through unchanged', () => {
    expect(mapObjects('hello', (obj) => obj)).toBe('hello')
    expect(mapObjects(null, (obj) => obj)).toBe(null)
    expect(mapObjects([1, 2, 3], (obj) => obj)).toEqual([1, 2, 3])
  })
})
