# Design to Json - TW

A Figma **Dev Mode codegen plugin**. Select any layer in Dev Mode and it renders that
layer's structure as JSON directly in the Inspect panel.

Because it is a codegen plugin, it does not appear in the normal Plugins menu and has no
dialog window. It runs inside Dev Mode's Inspect panel and re-runs automatically every
time you change your selection.

---

## Installing it in Figma

The plugin is not published, so it runs as a local development plugin.

1. Build it once (see [Development](#development) if you have not run `npm install` yet):

   ```bash
   npm install
   npm run build
   ```

   This compiles `code.ts` into `code.js`. **Figma loads `code.js`, not `code.ts`** — if you
   skip this step the plugin throws `This plugin template uses TypeScript…` on load.

2. In the Figma desktop app, open any design file.
3. Go to **Plugins → Development → Import plugin from manifest…**
4. Select the `manifest.json` in this folder.

The plugin now appears under **Plugins → Development** as *Design to Json - TW*.

## Using it

1. Open a design file and switch to **Dev Mode** (the toggle in the top-right of the
   toolbar, or press <kbd>Shift</kbd> + <kbd>D</kbd>).
2. Select any layer on the canvas.
3. Open the **Inspect** panel on the right.
4. In the code section, open the language dropdown and choose one of:

   | Option | What you get |
   | --- | --- |
   | **JSON (Summary)** | A compact, readable tree of the layer's visual properties |
   | **JSON (Figma REST)** | The full export in Figma's REST API format |

The JSON updates on its own as you click between layers. Use the copy button in the corner
of the code block to copy it.

> **Dev Mode requires a paid plan** — a Full or Dev seat. It is not available on the free
> plan. If you cannot switch to Dev Mode, that is a Figma account limitation rather than a
> problem with this plugin.

## What the two outputs contain

### JSON (Summary)

A hand-built tree covering the properties most people actually want. Keys are omitted when
they do not apply, so a plain rectangle stays short while an auto-layout frame carries its
full layout description.

| Key | Notes |
| --- | --- |
| `id`, `name`, `type` | Always present |
| `visible` | Only when the layer is hidden |
| `size` | Width and height, rounded to 2 decimals |
| `opacity` | Only when not fully opaque |
| `cornerRadius` | Rounded corners |
| `fills`, `strokes`, `strokeWeight` | Colors converted from Figma's 0–1 RGB to hex. Invisible paints are dropped; gradients include their stops |
| `autoLayout` | Only for auto-layout frames: direction, gap, padding, alignment |
| `text` | Only for text layers: characters, font family and style, size, line height, alignment |
| `children` | Nested recursively |

Example, for a card frame containing one text layer:

```json
{
  "id": "1:1",
  "name": "Summary Card",
  "type": "FRAME",
  "size": { "width": 240, "height": 88 },
  "cornerRadius": 8,
  "fills": [{ "type": "SOLID", "color": "#ffffff", "opacity": 1 }],
  "strokes": [{ "type": "SOLID", "color": "#e6e6e6", "opacity": 1 }],
  "strokeWeight": 1,
  "autoLayout": {
    "direction": "VERTICAL",
    "gap": 8,
    "padding": { "top": 16, "right": 16, "bottom": 16, "left": 16 },
    "primaryAxisAlign": "MIN",
    "counterAxisAlign": "MIN"
  },
  "children": [
    {
      "id": "1:3",
      "name": "Label",
      "type": "TEXT",
      "size": { "width": 96, "height": 20 },
      "fills": [{ "type": "SOLID", "color": "#212121", "opacity": 1 }],
      "text": {
        "characters": "Total",
        "align": "LEFT",
        "fontFamily": "Inter",
        "fontStyle": "Medium",
        "fontSize": 14,
        "lineHeight": "20px"
      }
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

**Mixed values appear as `"MIXED"`.** When a layer has more than one value for a property —
several fonts in one text layer, different corner radii per corner — Figma reports a special
mixed value. It is emitted as the string `"MIXED"` rather than being dropped.

**Deep trees are truncated.** Recursion stops at 12 levels and emits
`"children": "TRUNCATED: <n> more children"`. This keeps the plugin inside Figma's
15-second codegen timeout.

**Very large REST exports are refused.** Above 400,000 characters the REST option returns an
error asking you to select a smaller layer, rather than freezing the panel.

**Errors are shown, not swallowed.** If anything fails, the panel shows an `Error` section
containing the message instead of going blank.

Both limits live at the top of `code.ts` as `MAX_DEPTH` and `MAX_REST_CHARS` if you want to
change them.

## Development

Requires [Node.js](https://nodejs.org/en/download/).

```bash
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
