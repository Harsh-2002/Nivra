# Nivra website

The minimal product website for [Nivra](https://github.com/Harsh-2002/Nivra), built with Astro and local Geist fonts. Supports light/dark themes and includes real product screenshots with demonstration content.

This orphan `web` branch contains only the website. The application lives independently on `main`. Do not merge these branches.

## Development

Requires Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open `http://localhost:4321/Nivra/`.

```sh
npm run lint
npm run check
npm run build
npm test
npm run preview
```

## Publishing

Push verified changes to `web`. The Pages workflow builds and publishes `dist/` at **https://harsh-2002.github.io/Nivra/**. Repository Pages settings must use **GitHub Actions**. Keep Astro’s `site`, `base`, canonical URL and font path together when changing the hosting address.

[PRODUCT.md](PRODUCT.md) records product truth; [DESIGN.md](DESIGN.md) records the site’s visual rules. The app README remains the source of installation instructions. Screenshots show curated demonstration data; private content is excluded. Capture sources, native dimensions and image processing metadata are indexed in [public/screenshots/provenance.json](public/screenshots/provenance.json).

MIT licensed. Geist’s license is in `public/licenses/`.
