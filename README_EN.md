<div align="center">

# Wallpaper Engine PKG Extractor Web

English | [简体中文](README.md)

</div>

Parses Wallpaper Engine `.pkg` (desktop) / `.mpkg` (Android) wallpaper packages **entirely in the user's browser**, extracting jpg / png / mp4 / webm and any other resource inside the package; supports `.tex` decoding and conversion. Everything runs locally and is independent of the web server, so it can be deployed as a static site. [Live Demo](https://pkg.cdsp.us.ci)

## Features

- Drag & drop / file picker for `.pkg` / `.mpkg` files, up to roughly 2GB (parsing reads only the table of contents; the archive never sits in memory)
- Entry list + image/video thumbnail previews + full-size modal viewer
- Automatic `.tex → jpg/png/mp4` conversion (can be disabled; when disabled, `.tex` files are exported as-is)
- Animated textures (`.tex` with a frame table) are re-encoded into a single **APNG** (lossless, keeps alpha) or **GIF** (256 colours, small), or both
- Multi-select cards: bulk download the selection, or ZIP it
- Single file download / streaming ZIP export preserving directory structure
- Filtering (images/videos/JSON), `project.json` metadata card

## Development & Verification

```bash
cd we-pkg-web
npm install
npm run dev        # http://localhost:5199
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
- No audio/video formats beyond `.webm` / `.mp4`
- PKGV (desktop `.pkg`) / PKGM (Android `.mpkg`) stores entry offsets as int32, so a **package larger than 2GB cannot exist** in this format; such files are rejected outright
- A single re-encoded animation larger than 200MB falls back to the first frame as PNG, with a dialog explaining why
