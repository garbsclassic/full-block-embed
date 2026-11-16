# Dependency upgrade

Status: active

## Problem

Six dev dependencies are a major (or breaking 0.x minor) version behind, and ESLint 9 is out of support. Each upgrade may change build, type-check, or lint behavior.

## Scope

Included:

- In-range updates for every package.
- Node floor raised from 22 to 26: `@types/node`, CI matrix, release workflow, `AGENTS.md`.
- esbuild 0.25 → 0.28.
- TypeScript 5.9 → 6.0.
- ESLint 9 → 10 with `eslint-plugin-obsidianmd` 0.4 → 0.6.

Excluded:

- TypeScript 7: typescript-eslint 8.72.2, the latest, supports `typescript >=4.8.4 <6.1.0`. Revisit when typescript-eslint supports 7.
- `@codemirror/view` 6.43.15 and later: `obsidian` 1.14.4 declares exact peers `@codemirror/view 6.43.13` and `@codemirror/state 6.7.6`, which match what Obsidian ships. Pin both to those versions.

## Design

One commit per upgrade, ordered so each stands alone and passes the full gate. In-range updates and the Node floor go first, since ESLint 10 and `eslint-plugin-obsidianmd` 0.6 require Node `^20.19 || ^22.13 || >=24`. TypeScript 6 lands before ESLint 10 so lint failures are attributable to one change at a time.

`@eslint/js` is not imported anywhere in the repo. It exists only as a peer of `eslint-plugin-obsidianmd` 0.4, and 0.6 drops that peer, so it is removed with the ESLint upgrade rather than bumped.

## Work

- [x] In-range updates; pin `@codemirror/view` and `@codemirror/state` to Obsidian's peers. Every in-range package was already current.
- [x] Node 26 floor: `@types/node ^26`, CI `26.x`, release workflow Node 26, `AGENTS.md`.
- [x] esbuild 0.28: read the 0.26–0.28 breaking changes and adjust `esbuild.config.mjs`. None touched the config: they cover trusted publishing, Go compiler upgrades, `Uint8Array.fromBase64` for the binary loader, and install-time integrity checks. The bundle shrank 30 bytes because the minifier now emits `()=>{f()}` instead of `()=>void f()`, which is equivalent.
- [x] TypeScript 6.0: fix changed compiler defaults and new errors. `src/` type-checked clean. TypeScript 6 defaults `types` to `[]`, so files linted through typescript-eslint's default project (`eslint.config.mts`, `tests/*.test.ts`) lost `@types/node` and failed hundreds of `no-unsafe-*` checks. `tsconfig.node.json` now supplies that project with `types: ["node"]`. Pinned to `~6.0` because typescript-eslint supports `<6.1.0`.
- [x] ESLint 10 and `eslint-plugin-obsidianmd` 0.6: fix new lint errors; drop `@eslint/js`.
    - Three of the plugin's own dependencies still declare ESLint 9 peers: `@microsoft/eslint-plugin-sdl` 1.1.0, `eslint-plugin-import` 2.32.0, and its nested `eslint-plugin-react` 7.37.3. npm overrides them with warnings, `npm ci` succeeds, and lint runs to completion. Watch for rule crashes until those packages support ESLint 10.
    - `no-unsupported-api` found `MarkdownRenderer.render` (1.3.5) and `Modal.setTitle` (1.5.1) under a declared `minAppVersion` of 1.1.0. Raised `minAppVersion`, and the 1.0.3 entry in `versions.json`, to 1.5.1 instead of adding version guards.
    - `prefer-active-doc` flagged `document` in `src/reading-view.ts`. It now uses `el.doc`, the document the rendered element belongs to, which stays correct for an unfocused popout where `activeDocument` would not.
- [ ] Bundle smoke check: compare `main.js` exports and size against the pre-upgrade build.

## Verification

After each commit: `npm run check` (lint and unit tests) and `npm run build` (type-check and production bundle). The plugin is not loaded in Obsidian by this work, so runtime behavior beyond the unit tests stays unverified.
