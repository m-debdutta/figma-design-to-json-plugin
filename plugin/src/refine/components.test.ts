import { describe, expect, it } from 'vitest'
import { Json, JsonObject, isObject } from '../types'
import { extractComponents } from './components'

// Mirrors the documented substitution rule: `components.X.node` with every
// "{{slot}}" replaced by the matching entry in a reference's `props`
// reproduces the original subtree exactly.
function substitute(node: Json, props: JsonObject): Json {
  if (Array.isArray(node)) return node.map((item) => substitute(item, props))
  if (typeof node === 'string') {
    const match = /^\{\{(.+)\}\}$/.exec(node)
    return match ? props[match[1]] : node
  }
  if (!isObject(node)) return node
  const result: JsonObject = {}
  for (const key of Object.keys(node)) result[key] = substitute(node[key], props)
  return result
}

function row(label: string, iconColor: string): JsonObject {
  return {
    name: 'Row',
    type: 'FRAME',
    fill: '#FFFFFF',
    cornerRadius: 4,
    layout: { mode: 'row', gap: 8 },
    children: [
      { name: 'Label', type: 'TEXT', characters: label, font: { family: 'Inter', size: 14 } },
      { name: 'Icon', type: 'VECTOR', fill: iconColor, size: { width: 16, height: 16 } },
    ],
  }
}

describe('extractComponents', () => {
  it('lifts a repeated subtree into components and replaces each occurrence with a use/props reference', () => {
    const rows = [
      row('Investors', '#05DF72'),
      row('Revenue', '#3B82F6'),
      row('Headcount', '#F59E0B'),
      row('Runway', '#EF4444'),
    ]
    const tree: JsonObject = { name: 'List', type: 'FRAME', children: rows }

    const { tree: resultTree, components } = extractComponents(tree)

    expect(Object.keys(components)).toEqual(['Row'])
    const children = (resultTree as JsonObject).children as JsonObject[]
    expect(children).toHaveLength(4)

    // Every reference, substituted back into the component definition, reproduces its original row.
    children.forEach((reference, index) => {
      expect(reference.use).toBe('Row')
      const component = components[reference.use as string] as JsonObject
      const rebuilt = substitute(component.node, reference.props as JsonObject)
      expect(rebuilt).toEqual(rows[index])
    })
  })

  it('does not extract when the duplicated subtree is too small to be worth the indirection', () => {
    const dot = (fill: string): JsonObject => ({ name: 'Dot', type: 'ELLIPSE', fill, size: { width: 4, height: 4 } })
    const tree: JsonObject = {
      name: 'Group',
      type: 'GROUP',
      children: [dot('#000000'), dot('#FFFFFF'), dot('#FF0000')],
    }

    const { tree: resultTree, components } = extractComponents(tree)

    expect(components).toEqual({})
    expect(resultTree).toEqual(tree)
  })

  it('passes over a candidate with too many varying props so a smaller subtree inside it is extracted instead', () => {
    // Enough shared boilerplate per item that lifting it out actually pays for itself.
    const items = (offset: number): JsonObject[] =>
      Array.from({ length: 17 }, (_, i) => ({
        name: 'Item',
        type: 'FRAME',
        layout: { mode: 'row', gap: 4 },
        fill: '#F8FAFC',
        cornerRadius: 6,
        children: [{ name: 'Label', type: 'TEXT', characters: 'Item ' + String(offset + i), font: { family: 'Inter', size: 12 } }],
      }))

    const tree: JsonObject = {
      name: 'List',
      type: 'FRAME',
      children: [
        { name: 'Row', type: 'FRAME', fill: '#FFFFFF', children: items(0) },
        { name: 'Row', type: 'FRAME', fill: '#FFFFFF', children: items(100) },
      ],
    }

    const { tree: resultTree, components } = extractComponents(tree)

    // "Row" has 17 differing props (over MAX_COMPONENT_PROPS) and is skipped...
    expect(components.Row).toBeUndefined()
    // ...but the smaller, uniform "Item" leaves underneath still get lifted out.
    expect(components.Item).toBeDefined()

    const rows = (resultTree as JsonObject).children as JsonObject[]
    for (const rowNode of rows) {
      expect(rowNode.type).toBe('FRAME')
      const rowChildren = rowNode.children as JsonObject[]
      expect(rowChildren).toHaveLength(17)
      for (const child of rowChildren) expect(child.use).toBe('Item')
    }
  })
})
