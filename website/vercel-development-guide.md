---
title: Vercel Development Guide
description: How to deploy and preview the Open CoDesign documentation website on Vercel.
---

# Vercel Development Guide

This guide covers deploying the Open CoDesign **documentation website** (VitePress) to Vercel — both for preview deployments on pull requests and for a production mirror alongside the default GitHub Pages host.

> The desktop Electron app itself is not deployed to Vercel. Only the `website/` VitePress docs are.

## Prerequisites

- A [Vercel](https://vercel.com) account (free tier is enough)
- `pnpm` 9.15+ and Node 22 LTS installed locally
- Repository forked or cloned from GitHub

## Repository layout

The docs live in `website/` and are built with VitePress:

```
open-codesign/
├── website/               # VitePress source
│   ├── .vitepress/
│   │   └── config.ts      # Site config, nav, sidebar
│   ├── index.md
│   ├── quickstart.md
│   └── ...
├── vercel.json            # Vercel build config (root)
├── package.json           # Workspace root
└── pnpm-workspace.yaml
```

## Local development

```bash
# Install all workspace dependencies
pnpm install

# Start the docs dev server (hot-reload)
pnpm docs:dev

# Build the docs for production
pnpm docs:build

# Preview the production build locally
pnpm docs:preview
```

The dev server starts at `http://localhost:5173` by default.

## Deploying to Vercel

### First-time setup

1. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
2. Vercel auto-detects the `vercel.json` at the repo root and uses these settings:

   | Setting | Value |
   |---|---|
   | Build command | `pnpm docs:build` |
   | Output directory | `website/.vitepress/dist` |
   | Install command | `pnpm install` |
   | Framework preset | None (static output) |

3. Click **Deploy**. The first build takes ~60 seconds.

### Environment variables

The docs site has no required environment variables. No secrets are needed for a basic deployment.

### Custom domain

In the Vercel project dashboard, go to **Settings → Domains** and add your domain. Vercel provisions TLS automatically.

## Preview deployments

Vercel creates a unique preview URL for every push to any branch. This is useful for reviewing doc changes before merging.

To trigger a preview:

```bash
git checkout -b docs/my-change
# edit files in website/
git add website/
git commit -m "docs: add my change"
git push -u origin docs/my-change
```

Vercel posts the preview URL in the GitHub pull request within ~60 seconds.

## Production deployment

The default production branch is `main`. Every merge to `main` triggers a new production build automatically.

To promote a preview to production manually, go to **Deployments** in the Vercel dashboard, find the deployment, and click **Promote to Production**.

## Monorepo notes

Because this is a pnpm workspace, Vercel must run `pnpm install` from the repo root to hoist workspace dependencies. The `vercel.json` at the root handles this — do not move it into `website/`.

If you add new VitePress plugins or dependencies, install them inside the `website` package:

```bash
pnpm --filter open-codesign-website add -D <package>
```

Then commit both `package.json` (inside `website/`) and the updated `pnpm-lock.yaml`.

## Troubleshooting

### Build fails with "Cannot find module"

Run `pnpm install` locally and confirm the lock file is committed. Vercel uses the lock file to reproduce the exact install.

### Output directory not found

Check that `pnpm docs:build` completes without errors locally. The build output must land in `website/.vitepress/dist`; if VitePress config changes the `outDir`, update `vercel.json` accordingly.

### Base path mismatch

The VitePress config sets `base: '/open-codesign/'` for GitHub Pages. On Vercel the site is served from the domain root, so links may break if you copy-paste a GitHub Pages URL.

To run a Vercel-targeted build locally without the sub-path:

```bash
VITE_BASE=/ pnpm docs:build
```

Or temporarily change `base` in `website/.vitepress/config.ts` to `/` before building for Vercel.

## Related

- [Architecture](./architecture) — full monorepo layout
- [Quickstart](./quickstart) — installing the desktop app
- [Contributing](https://github.com/OpenCoworkAI/open-codesign/blob/main/CONTRIBUTING.md) — PR and code style guidelines
