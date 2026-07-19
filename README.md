# Mermaid Preview — JCode extension

Preview [Mermaid](https://mermaid.js.org) diagrams inside JCode, fully offline.

## Features

- **Chart tab preview** — long-press a `.mmd`/`.mermaid` file (or a Markdown file with
  ```` ```mermaid ```` fences) in the editor and choose **Preview Mermaid Charts**: every
  diagram renders as a card with zoom controls and a collapsible source view.
- **Document preview with inline charts** — choose **Preview Document (Inline Charts)** on a
  Markdown file to read the whole document with each mermaid fence rendered in place.
- **Inline charts in the built-in Markdown preview** — with this extension installed, JCode's
  own Markdown preview renders mermaid fences inline (live, while you type) by loading the
  bundled Mermaid engine from this extension.
- Follows the active editor tab (toggleable), refreshes on save, matches the app theme
  (light/dark), and needs no network — Mermaid v11 ships inside the package.

## Development

```
npm install
npm run build        # tsc --noEmit + esbuild → www/
```

Pack with `jext pack` (runs the build automatically); sideload the unsigned `.jext` via
JCode's Developer options for testing.

## Layout

- `src/` — TypeScript UI (`main.ts`), HTML shell, styles (bundled to `www/` by `build.mjs`)
- `vendor/mermaid.min.js` — vendored Mermaid UMD bundle (copied into `www/` at build)
- `www/` — the built, shipping frontend
- `extension.yaml` — manifest + marketplace header
