import { beforeEach, describe, expect, it } from 'vitest'
import { installFigmaStub } from '../test/figma-stub'
import { rgbaToHex } from '../format'
import { resolveColorTokens } from './tokens'

const LIGHT = { r: 0.28, g: 0.335, b: 0.412, a: 1 }
const DARK = { r: 0.58, g: 0.64, b: 0.72, a: 1 }
const hexLight = rgbaToHex(LIGHT, 1)
const hexDark = rgbaToHex(DARK, 1)

interface FakeVariable {
  resolvedType: string
  variableCollectionId: string
  valuesByMode: Record<string, unknown>
  name: string
}
interface FakeCollection {
  modes: { modeId: string; name: string }[]
  defaultModeId: string
}

function stubVariables(variables: Record<string, FakeVariable>, collections: Record<string, FakeCollection>) {
  installFigmaStub({
    variables: {
      getVariableByIdAsync: async (id: string) => variables[id] ?? null,
      getVariableCollectionByIdAsync: async (id: string) => collections[id] ?? null,
    },
  })
}

beforeEach(() => {
  installFigmaStub()
})

describe('resolveColorTokens', () => {
  it('resolves a single-mode variable to a plain hex string, keyed by its name', async () => {
    stubVariables(
      { 'var-1': { resolvedType: 'COLOR', variableCollectionId: 'col-1', valuesByMode: { 'mode-1': LIGHT }, name: 'Colors/Slate/900' } },
      { 'col-1': { modes: [{ modeId: 'mode-1', name: 'Mode 1' }], defaultModeId: 'mode-1' } },
    )

    const marker = { $token: 'VARIABLE' as const, $id: 'var-1', $literal: '#000000' }
    const { tree, colors } = await resolveColorTokens({ fill: marker })

    expect(colors).toEqual({ 'Colors/Slate/900': hexLight })
    expect(tree).toEqual({ fill: 'Colors/Slate/900' })
  })

  it('keeps one hex per mode when a variable\u2019s modes disagree, and collapses when they agree', async () => {
    stubVariables(
      {
        'var-2': {
          resolvedType: 'COLOR',
          variableCollectionId: 'col-2',
          valuesByMode: { 'm-light': LIGHT, 'm-dark': DARK },
          name: 'Utility/Slate/600',
        },
        'var-3': {
          resolvedType: 'COLOR',
          variableCollectionId: 'col-2',
          valuesByMode: { 'm-light': LIGHT, 'm-dark': LIGHT },
          name: 'Utility/Slate/700',
        },
      },
      {
        'col-2': {
          modes: [
            { modeId: 'm-light', name: 'Light mode' },
            { modeId: 'm-dark', name: 'Dark mode' },
          ],
          defaultModeId: 'm-light',
        },
      },
    )

    const { colors } = await resolveColorTokens({
      a: { $token: 'VARIABLE' as const, $id: 'var-2', $literal: '#000000' },
      b: { $token: 'VARIABLE' as const, $id: 'var-3', $literal: '#000000' },
    })

    expect(colors['Utility/Slate/600']).toEqual({ 'Light mode': hexLight, 'Dark mode': hexDark })
    expect(colors['Utility/Slate/700']).toBe(hexLight)
  })

  it('follows an alias chain, preferring the target mode with the same name', async () => {
    stubVariables(
      {
        'var-a': {
          resolvedType: 'COLOR',
          variableCollectionId: 'col-a',
          valuesByMode: {
            'light-a': { type: 'VARIABLE_ALIAS', id: 'var-b' },
            'dark-a': { type: 'VARIABLE_ALIAS', id: 'var-b' },
          },
          name: 'Component colors/Utility/Slate/utility-slate-600',
        },
        'var-b': {
          resolvedType: 'COLOR',
          variableCollectionId: 'col-b',
          valuesByMode: { 'b-light': LIGHT, 'b-dark': DARK },
          name: 'Primitives/Slate/600',
        },
      },
      {
        'col-a': {
          modes: [
            { modeId: 'light-a', name: 'Light mode' },
            { modeId: 'dark-a', name: 'Dark mode' },
          ],
          defaultModeId: 'light-a',
        },
        // The target's default mode intentionally differs from the name-matched mode,
        // so a naive "always use the default mode" resolution would fail this test.
        'col-b': {
          modes: [
            { modeId: 'b-light', name: 'Light mode' },
            { modeId: 'b-dark', name: 'Dark mode' },
          ],
          defaultModeId: 'b-light',
        },
      },
    )

    const { colors } = await resolveColorTokens({
      fill: { $token: 'VARIABLE' as const, $id: 'var-a', $literal: '#000000' },
    })

    expect(colors['Component colors/Utility/Slate/utility-slate-600']).toEqual({
      'Light mode': hexLight,
      'Dark mode': hexDark,
    })
  })

  it('resolves a single-solid paint style to its name and hex', async () => {
    installFigmaStub({
      getStyleByIdAsync: async (id: string) =>
        id === 'style-1'
          ? {
              type: 'PAINT',
              name: 'Primary/Button',
              paints: [{ type: 'SOLID', visible: true, opacity: 1, color: LIGHT }],
            }
          : null,
    })

    const { tree, colors } = await resolveColorTokens({
      fill: { $token: 'STYLE' as const, $id: 'style-1', $literal: '#000000' },
    })

    expect(colors).toEqual({ 'Primary/Button': hexLight })
    expect(tree).toEqual({ fill: 'Primary/Button' })
  })

  it('falls back to the literal value when the variable cannot be resolved', async () => {
    const { tree, colors } = await resolveColorTokens({
      fill: { $token: 'VARIABLE' as const, $id: 'missing', $literal: '#ABCDEF' },
    })

    expect(colors).toEqual({})
    expect(tree).toEqual({ fill: '#ABCDEF' })
  })

  it('disambiguates two different variables that happen to share a name', async () => {
    stubVariables(
      {
        'var-x': { resolvedType: 'COLOR', variableCollectionId: 'col-x', valuesByMode: { m: LIGHT }, name: 'Brand/Primary' },
        'var-y': { resolvedType: 'COLOR', variableCollectionId: 'col-x', valuesByMode: { m: DARK }, name: 'Brand/Primary' },
      },
      { 'col-x': { modes: [{ modeId: 'm', name: 'Mode' }], defaultModeId: 'm' } },
    )

    const { colors } = await resolveColorTokens({
      a: { $token: 'VARIABLE' as const, $id: 'var-x', $literal: '#000000' },
      b: { $token: 'VARIABLE' as const, $id: 'var-y', $literal: '#000000' },
    })

    expect(colors).toEqual({ 'Brand/Primary': hexLight, 'Brand/Primary (2)': hexDark })
  })
})
