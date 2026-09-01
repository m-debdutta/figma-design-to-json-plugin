# Design to Json - TW

A Figma **Dev Mode codegen plugin**. Select any layer in Dev Mode and it renders that
layer's structure as JSON directly in the Inspect panel — no dialog, no manual export step.

Because it is a codegen plugin, it does not appear in the normal Plugins menu and has no
dialog window. It runs inside Dev Mode's Inspect panel and re-runs automatically every
time you change your selection.

---

## What it does

When you select a layer in Dev Mode, the plugin walks that layer's structure and prints it
as JSON in the Inspect panel's code section, updating automatically whenever the selection
changes. It offers two output formats, chosen from the language dropdown in the code
section:

| Option | What you get |
| --- | --- |
| **JSON (Summary)** | A compact, readable JSON tree of the layer's visual properties — name, type, colors, layout, sizing, text — with defaults and redundant data left out and repeated layers de-duplicated into reusable components. Built to be easy for an AI agent or human to read. |
| **JSON (Figma REST)** | The same JSON shape returned by Figma's REST API, for feeding into tooling that already speaks that format. It is considerably more verbose than the summary. |

## How to use it in Figma

The plugin is not published, so it must be installed and run as a local development
plugin.

### 1. Install it

1. Build it once (see [Development](#development) if you have not run `npm install` yet):

   ```bash
   cd plugin
   npm install
   npm run build
   ```

   This compiles `code.ts` into `code.js`. **Figma loads `code.js`, not `code.ts`** — if you
   skip this step the plugin throws `This plugin template uses TypeScript…` on load.

2. In the Figma desktop app, open any design file.
3. Go to **Plugins → Development → Import plugin from manifest…**
4. Select the `manifest.json` in the `plugin` folder.

The plugin now appears under **Plugins → Development** as *Design to Json - TW*.

### 2. Use it

1. Open a design file and switch to **Dev Mode** (the toggle in the top-right of the
   toolbar, or press <kbd>Shift</kbd> + <kbd>D</kbd>).
2. Select any layer on the canvas.
3. Open the **Inspect** panel on the right.
4. In the code section, open the language dropdown and choose **JSON (Summary)** or
   **JSON (Figma REST)**.
5. Use the copy button in the corner of the code block to copy the JSON.

The JSON updates on its own as you click between layers.

> **Dev Mode requires a paid plan** — a Full or Dev seat. It is not available on the free
> plan. If you cannot switch to Dev Mode, that is a Figma account limitation rather than a
> problem with this plugin.

## What the two outputs contain

### JSON (Summary)

Built in two phases. First the plugin walks the layer and records what it finds; then it
runs a series of passes over that JSON, each one removing something an AI agent would
otherwise have to read. The result is smaller than the raw tree and says more per line.

Top level:

```json
{
  "notation": { "components": "…", "colors": "…", "units": "…" },
  "colors": { "Colors/Slate/900": "#0F172A" },
  "components": { "Row": { "node": { … }, "props": ["label_characters"] } },
  "nodes": [ { "name": "Card", "type": "FRAME", … } ]
}
```

`nodes` is always present; `colors` and `components` only when the design uses them, and
`notation` only when there is a convention worth spelling out.

Per node:

| Key | Notes |
| --- | --- |
| `name`, `type` | Always present. `id` is dropped — see `INCLUDE_NODE_IDS` below |
| `characters`, `font`, `align`, `segments` | Text layers. `segments` only for mixed-style runs |
| `color` | Text colour, as a hex value or a token name |
| `fill` / `fills`, `stroke` / `strokes`, `strokeWeight` | Scalar when there is one solid paint, an array for gradients and multi-paint. Hex is uppercase, with alpha folded in as `#RRGGBBAA` |
| `cornerRadius`, `effects`, `opacity`, `visible` | Omitted at their defaults |
| `layout` | `mode: "row" \| "column"`, `gap`, `padding`, alignment — auto-layout frames only. `layout.sizing` (`FIXED` / `HUG` / `FILL`) appears wherever Figma knows it |
| `constraints` | Omitted when it is Figma's `MIN`/`MIN` default |
| `size` | Only when it cannot be inferred (see below) |
| `position` | `x`/`y` relative to the parent, only where auto-layout is not doing the arranging |
| `children` | Nested recursively |

**Colours become design tokens where they have names.** A fill or stroke driven by a Figma
variable or a paint style is emitted as that token's name, and the name is resolved once in
the top-level `colors` map. Variables with several modes keep all of them, so light/dark
pairs stay visible:

```json
"colors": {
  "Colors/Slate/900": "#0F172A",
  "Component colors/Utility/Slate/utility-slate-600": {
    "Light mode": "#475569",
    "Dark mode": "#94A3B8"
  }
}
```

Alias chains are followed, preferring a mode of the same name in the target collection. A
variable that cannot be read falls back to its literal hex rather than failing.

**Repeated subtrees are lifted into components.** Layers with the same shape — same type,
property set and children, all the way down — are emitted once under `components`, with
whatever differs between them turned into a `{{placeholder}}`. Each occurrence in the tree
becomes a reference:

```json
{ "use": "Row", "props": { "label_characters": "Investors", "icon_stroke": "#05DF72" } }
```

Substituting `props` back into `components.Row.node` reproduces the original subtree
exactly — nothing is lost, only de-duplicated. Props are named after the layer and property
they fill and are listed content-first, so the list doubles as a description of what varies.
Layer names are not part of the shape test below the top of each group, since duplicated
rows and overridden instances routinely differ in layer name.

Extraction is skipped when it would not pay for itself: a group has to save more characters
than `MIN_COMPONENT_SAVINGS`, and a candidate needing more than `MAX_COMPONENT_PROPS`
placeholders is passed over so the smaller, tighter subtrees inside it get extracted
instead. Outer groups are considered before inner ones.

**Sizes an agent can work out are dropped.** `HUG` means the node is sized by its content,
`FILL` by its parent, and a `GROUP` is exactly the bounding box of its children — in each
case the number carries no information the rest of the JSON does not already give. Fixed
axes keep their number, so a fixed-width hugging frame emits `"size": { "width": 320 }`.

Example, for a card frame containing one text layer:

```json
{
  "nodes": [
    {
      "name": "Summary Card",
      "type": "FRAME",
      "fill": "#FFFFFF",
      "stroke": "#E6E6E6",
      "strokeWeight": 1,
      "cornerRadius": 8,
      "layout": {
        "mode": "column",
        "gap": 8,
        "padding": { "top": 16, "right": 16, "bottom": 16, "left": 16 },
        "sizing": { "horizontal": "FIXED", "vertical": "HUG" }
      },
      "size": { "width": 240 },
      "children": [
        {
          "name": "Label",
          "type": "TEXT",
          "characters": "Total",
          "color": "#212121",
          "font": { "family": "Inter", "style": "Medium", "size": 14, "lineHeight": 20 }
        }
      ]
    }
  ]
}
```

### JSON (Figma REST)

Calls `exportAsync({ format: 'JSON_REST_V1' })` and prints the result. This is the same
shape the Figma REST API returns, so it is the right choice when you need to feed the
output into tooling that already speaks that format. It is considerably more verbose than
the summary.

## Behaviour worth knowing

**Scaling follows your Inspect panel setting.** If the unit preference is set to a scaled
value (for example 2×), every dimension in the summary is multiplied accordingly. Switch
back to pixels for raw values.

**Mixed values appear as `"MIXED"` or are omitted.** When a layer has more than one value
for a property — several fonts in one text layer, different corner radii per corner — Figma
reports a special mixed value. Font family and size emit the string `"MIXED"`; a mixed
corner radius expands into per-corner keys; a mixed fill or stroke weight is left out rather
than guessed at.

**Deep trees are truncated.** Recursion stops at 18 levels and emits
`"children": "TRUNCATED: <n> more children"`. This keeps the plugin inside Figma's
15-second codegen timeout, as does a cap on how many distinct colour tokens are looked up.

**Very large REST exports are refused.** Above 400,000 characters the REST option returns an
error asking you to select a smaller layer, rather than freezing the panel.

**Errors are shown, not swallowed.** If anything fails, the panel shows an `Error` section
containing the message instead of going blank.

The knobs all live together at the top of `code.ts`:

| Constant | Default | Effect |
| --- | --- | --- |
| `MAX_DEPTH` | 18 | Recursion limit before `TRUNCATED` |
| `MAX_REST_CHARS` | 400000 | Size at which the REST export is refused |
| `MAX_TOKEN_LOOKUPS` | 400 | Distinct colour tokens resolved per run |
| `INCLUDE_NODE_IDS` | `false` | Keep Figma's `id` on every node |
| `INCLUDE_NOTATION` | `true` | Prefix the output with the `colors` / `components` conventions |
| `MIN_COMPONENT_SAVINGS` | 240 | Characters a component must save to be worth extracting |
| `MAX_COMPONENT_PROPS` | 16 | Placeholders past which a candidate is passed over |

## Development

Requires [Node.js](https://nodejs.org/en/download/). All commands run from the `plugin`
directory.

```bash
cd plugin
npm install      # once
npm run build    # compile code.ts -> code.js
npm run watch    # recompile on every save
npm run lint     # eslint
npm run lint:fix # eslint with autofix
```

`code.js` is generated and is gitignored — always edit `code.ts`.

After rebuilding, reload the plugin in Figma to pick up your changes:
**Plugins → Development → right-click the plugin → Reload plugin**. Editing `manifest.json`
requires a full re-import rather than a reload.

### Layout

| File | Purpose |
| --- | --- |
| `code.ts` | Plugin source — the `figma.codegen.on('generate', …)` handler |
| `code.js` | Compiled output that Figma loads (generated) |
| `manifest.json` | Plugin config: Dev Mode only, codegen capability, the two language options |
| `tsconfig.json` | TypeScript config (strict) |
| `eslint.config.js` | Lint rules, including Figma's plugin rules |

The two entries under `codegenLanguages` in `manifest.json` are what populate the Inspect
panel dropdown. Their `value` (`summary` and `rest`) is what the handler branches on via
`event.language`, so if you rename one, update `code.ts` to match.
