# Craft Studio — cross-platform editor prototype

An independently implemented, local-first browser editor with SVG export to
official Cricut Design Space for cutting. **This is a first working prototype,
not a feature-complete replacement.** It contains no copied Cricut code, fonts,
or catalog assets. This public repository contains the independent editor only;
the private application investigation and captured artifacts are excluded.

**Live editor:** https://craft-studio.tilbertrampetersen.workers.dev

Use current desktop Edge or Chrome on Windows or macOS. No installation or
login is needed for the hosted editor; cutting still happens in Design Space.

## Cloudflare hosting

Cloudflare Workers Static Assets hosts only the built `dist/` directory. There
is no server-side project/font storage, upload API, or required Cricut account.
Project drafts and imported fonts remain in your browser; download project files
for backups. A new website origin has separate storage from the local app.

To deploy from an authenticated personal Cloudflare account:

```sh
npm ci
npx wrangler login --use-keyring
npm run deploy
```

The repository's GitHub Actions workflow validates tests and the production
build. Deployments are manual through Wrangler; no Cloudflare credentials are
stored in Git or automatically copied into GitHub secrets.

## Run on Windows or macOS

Install Node.js 22.12 or newer (Node 24 LTS recommended), then run from this folder:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:5198** in current desktop Edge or Chrome. Do not open
`dist/index.html` directly: module workers require a web origin. The server binds
only to loopback and serves only the built editor, not research or design notes.
No internet/account is required to edit after installation/build.

For development, `npm run dev` serves http://127.0.0.1:5197. Browser drafts/fonts
belong to a specific browser profile and origin, so development and production
ports have separate storage. Download project files for backups and transfer.

The optional `release/craft-studio-0.1.0-portable.zip` contains the built editor, a loopback Node
server, a Windows launcher and third-party notices—no development dependencies or
research artifacts. Extract it and follow its `README.txt`; Node is still required.
It is a portable prototype, not a Windows installer. Rebuild/repackage with
`npm run build` followed by `python3 tools/package_portable.py` (exclusive output
creation; an existing bundle is never overwritten automatically).

Windows PowerShell users whose policy blocks `npm.ps1` can use `npm.cmd` in place
of `npm`; no execution-policy change is needed. Do not copy Mac `node_modules`
onto Windows—run `npm ci` there, or use the built portable bundle.

## First working workflow

1. Add simple shapes or import a flat, filled SVG. Document distances are mm.
2. Open **Fonts**, import a licensed standalone TTF/OTF, or request installed-font
   access where the browser supports it. Installed fonts are indexed as metadata;
   only chosen fonts are read for outlines.
3. Add text, change its wording/size, or select another font for selected text.
   The worker produces actual outline paths; the export does not depend on fonts
   being installed on the receiving computer.
4. Drag, Shift+select, nudge with arrow keys, resize/rotate via Properties, duplicate,
   hide/lock layers, undo/redo, and zoom/pan.
5. **Save project** downloads a portable `.craft.json`. An automatic browser draft
   is a convenience, not a substitute for a backup. Original fonts must be imported
   again to edit text on a different computer; its baked outlines remain portable.
6. **Export SVG**, import it into official Design Space, and check dimensions and
   paths before cutting. Direct machine communication is not implemented.

Shortcuts: Ctrl/Cmd+Z undo; Ctrl/Cmd+Shift+Z redo; Ctrl/Cmd+D duplicate; Ctrl/Cmd+S
download project; arrows nudge (Shift = 10 mm); Delete remove; V select; H pan;
Space+drag pan; Ctrl/Cmd+wheel zoom. A cancelled drag leaves no history entry.

## Performance design

- Incremental spatial index and viewport culling; cached Path2D geometry.
- Drag-only paint-order raster runs, with a 64 MiB raster budget, and one history
  command on release. Raster fallback preserves order for interleaved selections.
- Virtualized layer/font lists, no cloud catalog dependency.
- Font metadata persisted separately from bytes, avoiding loading every saved
  font file at startup. Content-hash identity, parse reuse while resident, and
  16-face / 64 MiB input-byte worker cache limits (parsed memory can be larger).
- Separate bounded preview/edit queues, singleflight requests, size-keyed LRU
  outline caches, stale-result guards, and a worker timeout.
- Draft saving deferred until outside a gesture. SVG import and project
  serialization still run on the main thread; large files may pause the UI and
  are candidates for the next performance pass.

## Current limitations

- Tested on macOS Chromium, not yet on her Windows hardware or against an
  authenticated Design Space canvas. No comparative speedup is claimed.
- Flat filled vectors only: convert text/strokes to paths in imported SVGs.
  Gradients, clipping, references, embedded raster images, evenodd fills and
  translucent SVG semantics are rejected rather than silently changed.
- Simple-script outline fonts only. No WOFF/collections/CFF2, full HarfBuzz/bidi,
  combining-mark layout, writing/single-stroke workflow or variable-font controls.
- No weld/slice/offset, true grouping, tracing, raster editing, cloud library,
  print-and-cut, direct cutter connection or Windows/macOS installers yet.
- At most 10,000 objects, 10 MiB project/SVG input, 16 MiB font input, and bounded
  path/text budgets. Installed-font access is optional and browser-dependent.
- Local browser storage can fail or be cleared; the UI reports failures. Keep
  downloaded project files and licensed original font files.

## Validation

```sh
npm test
npm run test:e2e
npm audit
```

Browser tests use installed Chrome on this Mac. Elsewhere install Playwright
Chromium with `npx playwright install chromium`, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a compatible installed Chromium browser.
They cover drag/undo, physical-size SVG export, project reopen, hostile SVG
rejection, font persistence and a synthetic 5,000-object gesture. That fixture
reports canvas draw duration only—not input-to-display latency or a Design Space
comparison. An authenticated Design Space canvas has not been benchmarked.
