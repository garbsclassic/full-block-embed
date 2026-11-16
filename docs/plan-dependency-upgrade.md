# Dependency upgrade

Branch: `chore/upgrade-dependencies` · Started: 2026-11-15

- [Goal](#goal)
- [Scope](#scope)
- [Decisions](#decisions)
- [Steps](#steps)
- [What this breaks](#what-this-breaks)
- [Verification](#verification)
- [Caveats](#caveats)
- [Open questions](#open-questions)

## Goal

Every dev dependency is on its newest version that the rest of the toolchain supports, and the build, type-check, lint, and tests pass on it. Six packages were a major (or breaking 0.x minor) version behind, and ESLint 9 was out of support.

## Scope

In:

- In-range updates for every package
- Node floor raised from 22 to 26: `@types/node`, CI matrix, release workflow, [AGENTS.md](../AGENTS.md)
- esbuild 0.25 → 0.28
- TypeScript 5.9 → 6.0
- ESLint 9 → 10 with `eslint-plugin-obsidianmd` 0.4 → 0.6
- Fixes for whatever the new versions flag

Out:

- TypeScript 7: deferred until typescript-eslint supports it; see [Decisions](#decisions)
- `@codemirror/view` 6.43.15 and later: dropped while `obsidian` pins 6.43.13; see [Decisions](#decisions)
- Loading the plugin in Obsidian: dropped from this work; runtime behavior past the unit tests is unverified

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| TypeScript target | `~6.0` | 7.0 | typescript-eslint 8.72.2 supports only `typescript <6.1.0` |
| Node floor | 26 | Keep 22; raise to 24 | Owner's call |
| CodeMirror versions | Exact pins at 6.7.6 / 6.43.13 | Latest 6.43.15 | `obsidian` 1.14.4 declares those exact peers |
| esbuild range | Exact pin | Caret range | 0.x minor releases are breaking |
| Node types for lint-only files | `tsconfig.node.json` as typescript-eslint's `defaultProject` | `tests/tsconfig.json` | Also covers `eslint.config.mts`, which sits outside `tests/` |
| APIs above the declared floor | Raise `minAppVersion` to 1.5.1 | `requireApiVersion` guards | The code already requires 1.5.1 everywhere it opens a modal |
| Document for DOM calls in reading view | `el.doc` | `activeDocument`, as the lint rule suggests | Stays correct for an unfocused popout window |
| `@eslint/js` | Remove | Bump to 10 | Never imported; only a peer of `eslint-plugin-obsidianmd` 0.4 |
| Older `versions.json` entries | All raised to 1.5.1 | Raise only 1.0.3 | Releases 1.0.0 to 1.0.2 call the same APIs |
| ESLint 9 peers inside `eslint-plugin-obsidianmd` | Accept npm's peer overrides | Stay on ESLint 9 | The rules those packages contribute avoid APIs ESLint 10 removed |
| `npm audit` findings | Leave open | `npm audit fix --force` | Its fixes are downgrades to `eslint-plugin-obsidianmd` 0.0.2 and `typescript-eslint` 8.36 |

TypeScript 6 changed the default for `types` to `[]`. Files that typescript-eslint lints outside [tsconfig.json](../tsconfig.json), which are `eslint.config.mts` and `tests/*.test.ts`, lost `@types/node` and failed hundreds of `no-unsafe-*` checks. [tsconfig.node.json](../tsconfig.node.json) extends the main config and adds only `types: ["node"]`, so `src/` keeps no Node types, which suits a plugin that also runs on mobile.

The three packages with ESLint 9 peers are `@microsoft/eslint-plugin-sdl` 1.1.0, `eslint-plugin-import` 2.32.0, and its nested `eslint-plugin-react` 7.37.3. The recommended config enables only `@microsoft/sdl/no-document-write`, `@microsoft/sdl/no-inner-html`, and `import/no-extraneous-dependencies` from them, and all three use `context.sourceCode` or `eslint-module-utils/contextCompat`.

## Steps

### 1. Pin CodeMirror

- [x] Pin `@codemirror/state` 6.7.6 and `@codemirror/view` 6.43.13
- [x] Run `npm update` for in-range updates; every in-range package was already current
- [x] Check: `npm run check` and `npm run build` pass

### 2. Raise the Node floor to 26

- [x] `@types/node` to `^26`, CI matrix to `[26.x]`, release workflow to Node 26, [AGENTS.md](../AGENTS.md) to "26 or later"
- [x] Check: `npm run check` and `npm run build` pass

### 3. Upgrade esbuild to 0.28.2

- [x] Read the 0.26–0.28 breaking changes; none touch [esbuild.config.mjs](../esbuild.config.mjs). They cover trusted publishing, Go compiler upgrades, `Uint8Array.fromBase64` in the binary loader, and install-time integrity checks.
- [x] Check: the bundle differs from the 0.25.5 build only where the minifier now emits `()=>{f()}` for `()=>void f()`, which is equivalent

### 4. Upgrade TypeScript to 6.0

- [x] Install `typescript@~6.0.3`; `src/` type-checks clean
- [x] Add [tsconfig.node.json](../tsconfig.node.json) and point `projectService.defaultProject` at it in [eslint.config.mts](../eslint.config.mts)
- [x] Check: lint is clean again, and `npm run build` passes

### 5. Correct the Obsidian floor (before 6, whose rules enforce it)

- [x] Raise `minAppVersion` in [manifest.json](../manifest.json) from 1.1.0 to 1.5.1: `MarkdownRenderer.render` needs 1.3.5 and `Modal.setTitle` needs 1.5.1
- [x] Use `el.doc` for `createTreeWalker` and `createRange` in `ReadingViewRenderer.decorate` in [src/reading-view.ts](../src/reading-view.ts)
- [x] Check: `npm run check` and `npm run build` pass

### 6. Upgrade ESLint to 10 and `eslint-plugin-obsidianmd` to 0.6 (after 5)

- [x] Install `eslint@^10.15.0` and `eslint-plugin-obsidianmd@^0.6.0`; remove `@eslint/js`
- [x] Check: `npm ci` succeeds despite the peer overrides, and lint reports no problems

### 7. Require Obsidian 1.5.1 for every release (after 5)

- [x] Raise the 1.0.0, 1.0.1, and 1.0.2 entries in [versions.json](../versions.json) to 1.5.1
- [x] Add a test in [tests/manifest.test.ts](../tests/manifest.test.ts) that no `versions.json` entry is below `minAppVersion`
- [x] Check: the new test fails on the old `versions.json` and passes on the new one

## What this breaks

- Lint, tests, and builds need Node 26. This affects development only: the plugin runs inside Obsidian, and esbuild bundles it for `es2021`.
- Obsidian below 1.5.1 is no longer offered any release of the plugin. Every release already called `Modal.setTitle`, so those versions were getting a plugin that fails when it opens a modal.
- Released `versions.json` entries changed. Before step 7, the metadata pointed Obsidian 1.4 at release 1.0.2 as compatible.

CodeMirror is external in [esbuild.config.mjs](../esbuild.config.mjs), so its pins affect type-checking only. Nothing else in the bundle changed: split at statement boundaries, the final `main.js` differs from the pre-upgrade build only by the esbuild arrow rewrite and the two `el.doc` calls.

## Verification

- `npm ci`, `npm run check`, and `npm run build` pass on `main` after the merge: lint is clean and all 46 tests pass.
- `npm outdated` lists only the two exclusions: `typescript` 7.0.2 and `@codemirror/view` 6.43.15.
- `main.js` shrank from 44,618 to 44,582 bytes, and its only differences are the ones listed in [What this breaks](#what-this-breaks).

## Caveats

- `npm audit` reports 10 moderate findings, all one `minimatch` ReDoS reached through typescript-eslint and `eslint-plugin-obsidianmd`'s plugins. None of it is bundled into `main.js`.
- `ReadingViewRenderer.decorate` has no test, and the `el.doc` change is unverified in a running popout window. Popouts worked before the change too, because a tree walker or range from one document accepts nodes from another.

## Open questions

- Pin `obsidian` instead of `latest`? CodeMirror is now pinned to its exact peers, so a new Obsidian release with new peers fails to resolve with ERESOLVE instead of drifting. Pinning `obsidian` would make the three move together.

Deliberate choices from this work that look like mistakes are in [intent.md](intent.md).
