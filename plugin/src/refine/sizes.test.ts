import { describe, expect, it } from 'vitest'
import { dropDerivableSizes } from './sizes'

describe('dropDerivableSizes', () => {
  it('drops both layout.sizing and size for a text node that hugs both axes', () => {
    const input = {
      type: 'TEXT',
      name: 'Label',
      layout: { sizing: { horizontal: 'HUG', vertical: 'HUG' } },
      size: { width: 40, height: 20 },
    }
    expect(dropDerivableSizes(input)).toEqual({ type: 'TEXT', name: 'Label' })
  })

  it('always drops size on a GROUP, regardless of sizing', () => {
    const input = { type: 'GROUP', name: 'g', size: { width: 100, height: 40 } }
    expect(dropDerivableSizes(input)).toEqual({ type: 'GROUP', name: 'g' })
  })

  it('keeps only the fixed axis of size, and keeps layout.sizing when not both axes are fixed', () => {
    const input = {
      type: 'FRAME',
      name: 'f',
      layout: { mode: 'row', sizing: { horizontal: 'FIXED', vertical: 'HUG' } },
      size: { width: 320, height: 48 },
    }
    expect(dropDerivableSizes(input)).toEqual({
      type: 'FRAME',
      name: 'f',
      layout: { mode: 'row', sizing: { horizontal: 'FIXED', vertical: 'HUG' } },
      size: { width: 320 },
    })
  })

  it('drops layout.sizing (but keeps size) when both axes are fixed', () => {
    const input = {
      type: 'FRAME',
      name: 'f2',
      layout: { mode: 'column', sizing: { horizontal: 'FIXED', vertical: 'FIXED' } },
      size: { width: 200, height: 100 },
    }
    expect(dropDerivableSizes(input)).toEqual({
      type: 'FRAME',
      name: 'f2',
      layout: { mode: 'column' },
      size: { width: 200, height: 100 },
    })
  })

  it('leaves component references (no "type") untouched', () => {
    const input = { use: 'Row', props: { label: 'Hi' } }
    expect(dropDerivableSizes(input)).toEqual(input)
  })

  it('recurses into children', () => {
    const input = {
      type: 'FRAME',
      name: 'root',
      children: [{ type: 'GROUP', name: 'g', size: { width: 10, height: 10 } }],
    }
    expect(dropDerivableSizes(input)).toEqual({
      type: 'FRAME',
      name: 'root',
      children: [{ type: 'GROUP', name: 'g' }],
    })
  })
})
