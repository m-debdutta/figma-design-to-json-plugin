import { beforeEach, describe, expect, it } from 'vitest'
import { installFigmaStub } from '../test/figma-stub'
import { notation, orderKeys, stripNodeIds } from './polish'

beforeEach(() => {
  installFigmaStub()
})

describe('stripNodeIds', () => {
  it('removes id from a node (has both id and type)', () => {
    const input = { id: '1:2', name: 'Rect', type: 'RECTANGLE' }
    expect(stripNodeIds(input)).toEqual({ name: 'Rect', type: 'RECTANGLE' })
  })

  it('leaves objects without a "type" untouched, e.g. component references', () => {
    const input = { use: 'Row', props: { label: 'Hi' } }
    expect(stripNodeIds(input)).toEqual(input)
  })

  it('strips ids recursively through children', () => {
    const input = {
      id: '1:1',
      name: 'root',
      type: 'FRAME',
      children: [{ id: '1:2', name: 'child', type: 'TEXT' }],
    }
    expect(stripNodeIds(input)).toEqual({
      name: 'root',
      type: 'FRAME',
      children: [{ name: 'child', type: 'TEXT' }],
    })
  })
})

describe('orderKeys', () => {
  it('reorders a node’s keys to the canonical order, appending unknown keys', () => {
    const input = { children: [], name: 'Card', type: 'FRAME', fill: '#FFFFFF', custom: 1 }
    expect(Object.keys(orderKeys(input) as object)).toEqual(['name', 'type', 'fill', 'children', 'custom'])
  })

  it('orders a component reference (identified by "use") the same way', () => {
    const input = { props: { a: 1 }, use: 'Row' }
    expect(Object.keys(orderKeys(input) as object)).toEqual(['use', 'props'])
  })

  it('leaves plain maps (no "type" or "use") untouched, e.g. the colors table', () => {
    const input = { 'Colors/Slate/900': '#0F172A', 'Colors/Slate/50': '#F8FAFC' }
    expect(orderKeys(input)).toEqual(input)
    expect(Object.keys(orderKeys(input) as object)).toEqual(Object.keys(input))
  })
})

describe('notation', () => {
  it('returns undefined when there are no colors or components', () => {
    expect(notation({}, {})).toBeUndefined()
  })

  it('mentions components but not colors when only components are present', () => {
    const notes = notation({}, { Row: { node: {}, props: [] } }) as Record<string, unknown>
    expect(notes.components).toBeDefined()
    expect(notes.colors).toBeUndefined()
    expect(notes.units).toBeDefined()
  })

  it('mentions colors but not components when only colors are present', () => {
    const notes = notation({ 'Colors/Slate/900': '#0F172A' }, {}) as Record<string, unknown>
    expect(notes.colors).toBeDefined()
    expect(notes.components).toBeUndefined()
  })

  it('describes plain pixel units by default', () => {
    installFigmaStub({ codegen: { preferences: { unit: 'PIXELS' } } })
    const notes = notation({ x: '#FFFFFF' }, {}) as Record<string, unknown>
    expect(notes.units).toBe('Lengths are px. Colors are #RRGGBB or #RRGGBBAA.')
  })

  it('mentions the scale factor when the unit preference is SCALED', () => {
    installFigmaStub({ codegen: { preferences: { unit: 'SCALED', scaleFactor: 2 } } })
    const notes = notation({ x: '#FFFFFF' }, {}) as Record<string, unknown>
    expect(notes.units).toBe('Lengths are px, scaled 2x. Colors are #RRGGBB or #RRGGBBAA.')
  })
})
