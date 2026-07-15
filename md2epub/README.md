# MD2EPUB

Chrome extension that converts **Markdown-born webpages** (docs sites, tech
blogs) into clean Markdown or EPUB ebooks — and batch-binds whole article
series into a single book with a full table of contents and embedded images,
ready for Kindle.

## Repository layout

```
src/       Extension source (bundled with esbuild)
  popup.js       Popup UI logic, runtime i18n, Drive upload
  content.js     Page conversion (Turndown + custom table handling), batch crawler
  background.js  Service worker: job manager, badge progress, downloads
  offscreen.js   Offscreen document: image fetching + EPUB packaging
  epub.js        EPUB 3 builder (JSZip + marked) and image embedding
ext/       Extension static assets (manifest, _locales, icons, popup.html)
docs/      Official website (static, bilingual) — deploy the folder as-is
store/     Chrome Web Store listing assets (screenshots)
scripts/   build.sh — bundles src/ into ext/ and zips dist/md2epub.zip
```

## Build

```bash
npm install
npm run build        # -> dist/md2epub.zip (upload this to the Web Store)
```

For local development, load the `ext/` folder as an unpacked extension at
`chrome://extensions` (Developer mode → Load unpacked) after running a build.

## Architecture notes

- **Conversion** runs in a content script (Turndown with a custom table rule
  that handles missing `<thead>`, `colspan`/`rowspan`, and pipes in cells).
- **Batch jobs** live in the background service worker so they survive popup
  close and tab switches; progress is stored in `chrome.storage.session` and
  mirrored on the action badge. The popup is only a viewer/controller.
- **EPUB packaging** happens in an offscreen document because MV3 service
  workers cannot `createObjectURL`. Images are fetched into memory (never
  written to disk) under `optional_host_permissions`, requested at runtime
  only when the user opts into image embedding.
- **i18n**: `_locales/` (en, zh_CN, zh_TW) with a runtime language override in
  the popup (chrome.i18n alone cannot switch at runtime).
- **Google Drive** (optional): OAuth via `chrome.identity`, minimal
  `drive.file` scope. Requires a Client ID in `manifest.json` — see
  `ext/README-drive-setup.md`. The button stays hidden until configured.

## Placeholders to replace before release

- `ext/manifest.json` → `oauth2.client_id`
- `src/popup.js` → `HELP_URL` (official site)
- `docs/index.html` → Chrome Web Store link (`REPLACE_WITH_EXTENSION_ID`)

## License

Proprietary — © Limitless Ladies Minds Inc. (change as appropriate)
