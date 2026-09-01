import { beforeEach, describe, expect, it } from 'vitest'
import { installFigmaStub } from './test/figma-stub'
import { allocateName, rgbToHex, rgbaToHex, round, scale, toHexByte, toSnakeCase } from './format'

beforeEach(() => {
  installFigmaStub()
})

describe('round', () => {
  it('rounds to the given number of decimal places', () => {
    expect(round(1.2345, 2)).toBe(1.23)
    expect(round(4.567, 1)).toBe(4.6)
    expect(round(2, 2)).toBe(2)
  })
})

describe('toHexByte', () => {
  it('converts a 0-1 channel to a two-digit uppercase hex byte', () => {
    expect(toHexByte(0)).toBe('00')
    expect(toHexByte(1)).toBe('FF')
    expect(toHexByte(0.5)).toBe('80')
  })

  it('clamps out-of-range channels', () => {
    expect(toHexByte(-1)).toBe('00')
    expect(toHexByte(2)).toBe('FF')
  })
})

describe('rgbToHex / rgbaToHex', () => {
  it('renders a 6-digit hex for an opaque colour', () => {
    expect(rgbToHex({ r: 1, g: 0, b: 0 })).toBe('#FF0000')
    expect(rgbaToHex({ r: 1, g: 0, b: 0 }, 1)).toBe('#FF0000')
  })

  it('folds alpha into an 8-digit hex when not fully opaque', () => {
    expect(rgbaToHex({ r: 1, g: 0, b: 0 }, 0.5)).toBe('#FF000080')
    expect(rgbaToHex({ r: 1, g: 0, b: 0 }, 0)).toBe('#FF000000')
  })
})

describe('toSnakeCase', () => {
  it('lowercases and joins words with underscores', () => {
    expect(toSnakeCase('Icon Button')).toBe('icon_button')
    expect(toSnakeCase('  Card--Header  ')).toBe('card_header')
  })

  it('falls back to "node" for a string with no alphanumerics', () => {
    expect(toSnakeCase('***')).toBe('node')
  })
})

describe('allocateName', () => {
  it('returns the base name when it is free', () => {
    const used = new Set<string>()
    expect(allocateName('label', used)).toBe('label')
  })

  it('suffixes with an incrementing counter on collision', () => {
    const used = new Set<string>(['label'])
    expect(allocateName('label', used)).toBe('label_2')
    expect(allocateName('label', used)).toBe('label_3')
  })
})

describe('scale', () => {
  it('passes values through unchanged at 1x / pixel units', () => {
    installFigmaStub({ codegen: { preferences: { unit: 'PIXELS' } } })
    expect(scale(12.345)).toBe(12.35)
  })

  it('multiplies by the scale factor when the unit preference is SCALED', () => {
    installFigmaStub({ codegen: { preferences: { unit: 'SCALED', scaleFactor: 2 } } })
    expect(scale(10)).toBe(20)
  })

  it('returns 0 for non-finite input', () => {
    expect(scale(NaN)).toBe(0)
    expect(scale(Infinity)).toBe(0)
  })
})
