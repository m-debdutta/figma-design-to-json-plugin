// Minimal stand-in for the Figma Plugin API's `figma` global, for use in tests only.
export const FIGMA_MIXED = Symbol('figma.mixed')

export interface FigmaStub {
  mixed: symbol
  codegen: { preferences: { unit: 'PIXELS' | 'SCALED'; scaleFactor?: number } }
  variables: {
    getVariableByIdAsync: (id: string) => Promise<unknown>
    getVariableCollectionByIdAsync: (id: string) => Promise<unknown>
  }
  getStyleByIdAsync: (id: string) => Promise<unknown>
}

function defaultStub(): FigmaStub {
  return {
    mixed: FIGMA_MIXED,
    codegen: { preferences: { unit: 'PIXELS' } },
    variables: {
      getVariableByIdAsync: async () => null,
      getVariableCollectionByIdAsync: async () => null,
    },
    getStyleByIdAsync: async () => null,
  }
}

// Replaces the global `figma` with a fresh stub, shallow-merged with `overrides`.
// Returns the installed stub so a test can further patch individual methods.
export function installFigmaStub(overrides?: Partial<FigmaStub>): FigmaStub {
  const stub: FigmaStub = {
    ...defaultStub(),
    ...overrides,
    codegen: { preferences: { ...defaultStub().codegen.preferences, ...overrides?.codegen?.preferences } },
    variables: { ...defaultStub().variables, ...overrides?.variables },
  }
  ;(globalThis as unknown as { figma: FigmaStub }).figma = stub
  return stub
}
