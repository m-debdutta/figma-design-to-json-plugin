// Phase 2 pass: lifts repeated subtrees into reusable components, replacing
// each occurrence with a `{ use, props }` reference.
import { Json, JsonObject, isObject } from '../types'
import { allocateName, toSnakeCase } from '../format'
import { INCLUDE_NODE_IDS, MIN_COMPONENT_SAVINGS, MAX_COMPONENT_PROPS } from '../config'

// Nodes can share a component definition only when their whole shape matches —
// same type, property set and children, all the way down. That leaves values as
// the only thing free to differ, and those become the props.
//
// Layer names are deliberately *not* part of the shape below the group root:
// duplicated rows and overridden instances routinely differ in layer name while
// being structurally identical, and a differing name is just another prop.
const signatures = new Map<JsonObject, string>()

function signature(node: JsonObject): string {
  const cached = signatures.get(node)
  if (cached !== undefined) return cached

  const keys = Object.keys(node)
    .filter((key) => key !== 'id')
    .sort()
  const childSig = Array.isArray(node.children)
    ? node.children.map((child) => (isObject(child) ? signature(child) : '?')).join(',')
    : ''
  const sig = String(node.type) + '|' + keys.join(',') + '(' + childSig + ')'
  signatures.set(node, sig)
  return sig
}

// The root's name does count: it is what the component ends up being called,
// and merging a "Row" with a "Header" of the same shape would read as a lie.
function groupKey(node: JsonObject): string {
  return String(node.name) + '|' + signature(node)
}

interface NodeGroup {
  depth: number
  nodes: JsonObject[]
}

// depth 0 is the selected node itself, which is never replaced by a reference.
function collectGroups(node: JsonObject, depth: number, groups: Map<string, NodeGroup>): void {
  if (depth > 0 && typeof node.name === 'string' && typeof node.type === 'string') {
    const key = groupKey(node)
    const group = groups.get(key)
    if (group) group.nodes.push(node)
    else groups.set(key, { depth, nodes: [node] })
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) if (isObject(child)) collectGroups(child, depth + 1, groups)
  }
}

// Props are named after the node and property they fill — `investors_characters`,
// `vector_size` — so the props list reads as a description of what varies.
interface PropSlot {
  name: string
  key: string
}

// Content first, geometry last.
const PROP_ORDER = [
  'characters',
  'color',
  'fill',
  'fills',
  'stroke',
  'strokes',
  'strokeWeight',
  'font',
  'align',
  'segments',
  'effects',
  'cornerRadius',
  'opacity',
  'visible',
  'layout',
  'constraints',
  'size',
  'position',
  'children',
]

function propRank(key: string): number {
  const index = PROP_ORDER.indexOf(key)
  return index === -1 ? PROP_ORDER.length : index
}

interface BuiltComponent {
  node: Json
  props: string[]
  instanceProps: JsonObject[]
}

// Walks the whole group in lockstep. A property with the same value on every
// member stays literal in the definition — that is what keeps concrete values
// visible — while one that varies becomes a `{{slot}}` plus a value per member.
function buildTemplate(
  nodes: JsonObject[],
  used: Set<string>,
  slots: PropSlot[],
  instanceProps: JsonObject[],
): JsonObject {
  const first = nodes[0]
  const template: JsonObject = {}
  const nodeName = typeof first.name === 'string' ? first.name : 'node'

  for (const key of Object.keys(first)) {
    if (key === 'id') continue // unique per node by definition
    if (key === 'children' && Array.isArray(first.children)) continue // recursed below

    const values = nodes.map((node) => node[key])
    const encoded = values.map((value) => JSON.stringify(value))
    if (encoded.every((value) => value === encoded[0])) {
      template[key] = values[0]
      continue
    }

    const name = allocateName(toSnakeCase(nodeName) + '_' + toSnakeCase(key), used)
    slots.push({ name, key })
    values.forEach((value, index) => {
      instanceProps[index][name] = value === undefined ? null : value
    })
    template[key] = '{{' + name + '}}'
  }

  if (Array.isArray(first.children)) {
    template.children = first.children.map((child, index) => {
      if (!isObject(child)) return child
      const peers = nodes.map((node) => {
        const children = node.children
        const peer = Array.isArray(children) ? children[index] : undefined
        return isObject(peer) ? peer : child
      })
      return buildTemplate(peers, used, slots, instanceProps)
    })
  }

  return template
}

function buildComponent(nodes: JsonObject[]): BuiltComponent {
  const used = new Set<string>()
  const slots: PropSlot[] = []
  const instanceProps: JsonObject[] = nodes.map(() => ({}))
  const template = buildTemplate(nodes, used, slots, instanceProps)

  slots.sort((a, b) => propRank(a.key) - propRank(b.key) || a.name.localeCompare(b.name))
  return { node: template, props: slots.map((slot) => slot.name), instanceProps }
}

// Indirection is only worth it if it buys back more than it costs to explain.
function worthExtracting(nodes: JsonObject[], built: BuiltComponent, references: Json[]): boolean {
  const inline = nodes.reduce<number>((total, node) => total + JSON.stringify(node).length, 0)
  const extracted =
    JSON.stringify({ node: built.node, props: built.props }).length +
    references.reduce<number>((total, reference) => total + JSON.stringify(reference).length, 0)
  return inline - extracted >= MIN_COMPONENT_SAVINGS
}

function markSubtree(node: JsonObject, claimed: Set<JsonObject>): void {
  claimed.add(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) if (isObject(child)) markSubtree(child, claimed)
  }
}

function applyReplacements(node: JsonObject, replacements: Map<JsonObject, Json>, isRoot: boolean): Json {
  if (!isRoot) {
    const replacement = replacements.get(node)
    if (replacement !== undefined) return replacement
  }
  if (!Array.isArray(node.children)) return node
  return {
    ...node,
    children: node.children.map((child) =>
      isObject(child) ? applyReplacements(child, replacements, false) : child,
    ),
  }
}

export function extractComponents(tree: JsonObject): { tree: Json; components: JsonObject } {
  signatures.clear()
  const groups = new Map<string, NodeGroup>()
  collectGroups(tree, 0, groups)

  // Outermost first: once a subtree is lifted out, everything inside it is
  // either part of the definition or hidden behind a reference, so a deeper
  // group that straddles it could no longer be resolved.
  const candidates = Array.from(groups.values())
    .filter((group) => group.nodes.length > 1)
    .sort((a, b) => a.depth - b.depth || b.nodes.length - a.nodes.length)

  const components: JsonObject = {}
  const replacements = new Map<JsonObject, Json>()
  const claimed = new Set<JsonObject>()
  const usedNames = new Set<string>()

  for (const group of candidates) {
    if (group.nodes.some((node) => claimed.has(node))) continue

    const built = buildComponent(group.nodes)
    if (built.props.length > MAX_COMPONENT_PROPS) continue

    // Named before the size check so that check weighs the real references.
    const baseName = typeof group.nodes[0].name === 'string' ? group.nodes[0].name : 'Component'
    let displayName = baseName
    if (usedNames.has(displayName)) {
      let n = 2
      while (usedNames.has(baseName + String(n))) n++
      displayName = baseName + String(n)
    }

    const references: JsonObject[] = group.nodes.map((node, index) => {
      const reference: JsonObject = {}
      if (INCLUDE_NODE_IDS && typeof node.id === 'string') reference.id = node.id
      reference.use = displayName
      if (built.props.length > 0) reference.props = built.instanceProps[index]
      return reference
    })
    if (!worthExtracting(group.nodes, built, references)) continue

    usedNames.add(displayName)
    components[displayName] = { node: built.node, props: built.props }
    group.nodes.forEach((node, index) => {
      replacements.set(node, references[index])
      markSubtree(node, claimed)
    })
  }

  return { tree: applyReplacements(tree, replacements, true), components }
}
