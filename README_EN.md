<div align="center">

# Wallpaper Engine PKG Extractor Web

English | [简体中文](README.md)

</div>

Parses Wallpaper Engine `.pkg` (desktop) / `.mpkg` (Android) wallpaper packages, as well as standalone `.tex` texture files, **entirely in the user's browser**, extracting jpg / png / mp4 / webm and any other resource inside the package; supports `.tex` decoding and conversion. Everything runs locally and is independent of the web server, so it can be deployed as a static site. [Live Demo](https://pkg.cdsp.us.ci)

## Features

- Drag & drop / file picker / Ctrl+V paste for `.pkg` / `.mpkg` / `.tex` files, up to roughly 2GB (parsing reads only the table of contents; the archive never sits in memory)
- Entry list + image/video thumbnail previews + full-size modal viewer
- Automatic `.tex → jpg/png/mp4` conversion (can be disabled; when disabled, `.tex` files are exported as-is); video textures (a TEX wrapping an mp4) are passed through zero-copy as `.mp4`
- Selectable texture mip levels: top resolution only by default, or tick lower levels to export them too (suffixed `.mipN`)
- Animated textures (`.tex` with a frame table) are re-encoded into a single **APNG** (lossless, keeps alpha) or **GIF** (256 colours, small), or both; when a frame has ≤255 distinct colours the GIF uses an exact palette and is **pixel-for-pixel lossless** (true for most flat/vector-style wallpapers)
- Multi-select cards: bulk download the selection, or ZIP it
- Single file download / streaming ZIP export preserving directory structure
- Switchable layout: **by file type** (images / videos / music / JSON / other) or **by package directory tree**, and the choice is remembered; in directory mode the breadcrumb is clickable level by level and ← goes up one level
- Filtering (images/videos/JSON), `project.json` metadata card

## Development & Verification

```bash
cd WallpaperEngine-PKG-Extractor-Web
npm install
npm run dev
```

## Pages Deployment

- Clone this project:

  ```
  git git clone https://github.com/CelestialDomeStarPole/WallpaperEngine-PKG-Extractor-Web.git
  ```

  Run in the project root directory:

  ```bash
  npm run build
  ```

  The output is in `dist/`. Upload `dist/` to GitHub Pages / Cloudflare Pages / any static hosting — no backend, no network requests required.

- Or fork this project: connect your Cloudflare account and select the forked repository for **Pages** deployment.

### CF Pages Build Configuration

| Category | Value |
| :--- | :--- |
| Framework preset | None |
| Build command | `npm run build` |
| Output directory | `dist` |
| Root directory | Leave empty |

## Workers Deployment

- Clone this project and upload the folder to Cloudflare Workers, then deploy.
- Or fork this project: connect your Cloudflare account and select the forked repository for **Workers** deployment.

### CF Workers Build Configuration

| Category | Value |
| :--- | :--- |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Version command | `npx wrangler versions upload` |
| Root directory | `/` |

## Roadmap

- Encrypted PKG support

## Format References

- Container and TEX layout translated byte-by-byte from [notscuffed/repkg](https://github.com/notscuffed/repkg) (MIT)
- Phase 2 encryption support: register a new `ContainerAdapter` in `src/core/adapter.ts` (`PKG ` v1/v2: AES-CTR keystream + per-file zlib); the core pipeline requires no changes.

## Known Limitations

- Workshop-encrypted packages (`PKG ` v1/v2) are not supported yet; planned for phase two
- No video formats beyond `.webm` / `.mp4`
- PKGV (desktop `.pkg`) / PKGM (Android `.mpkg`) stores entry offsets as int32, so a **package larger than 2GB cannot exist** in this format; such files are rejected outright
- A single re-encoded animation larger than 200MB falls back to the first frame as PNG, with a dialog explaining why
- Animated textures always export the top mip level (re-encoding works on the whole sprite sheet); the level selection does not affect them
- GIF is limited to 256 colours per frame: beyond that we use bucketing + median cut + ordered dithering, which introduces a slight quantisation error (pick APNG for full fidelity)
