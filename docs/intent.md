# Intent

Deliberate choices that look like mistakes. Check here before correcting an inconsistency; remove a line when its reason expires.

## Attribution

- [LICENSE](../LICENSE) keeps `Copyright (c) 2026 Matt Troncali` in this fork: the MIT license requires preserving the original notice, and [tests/manifest.test.ts](../tests/manifest.test.ts) checks for it.
- The provenance paragraph in [README.md](../README.md) links to `troncali/full-block-embed` while every other link points to the fork: it credits the original project.

## Dependencies

- `@codemirror/state` and `@codemirror/view` are pinned exactly, below their latest versions: they match the exact peers `obsidian` declares, which are the versions Obsidian ships.
- `typescript` is on `~6.0`, not 7 or `^6`: typescript-eslint supports only `typescript <6.1.0`.
- `esbuild` is pinned exactly: its 0.x minor releases carry breaking changes.
- npm prints "ERESOLVE overriding peer dependency" for ESLint 10 on every install: three packages inside `eslint-plugin-obsidianmd` 0.6 still declare ESLint 9 peers, but the rules they contribute avoid APIs ESLint 10 removed.
- `npm audit`'s moderate findings stay open: they are a lint-time `minimatch` ReDoS that never reaches `main.js`, and the suggested fixes are downgrades.

## Build and lint

- CI tests only Node 26.x: 26 is the supported floor, and no older Node is tested.
- [tsconfig.node.json](../tsconfig.node.json) exists beside [tsconfig.json](../tsconfig.json): TypeScript 6 stopped loading `@types/node` by default, so it gives the files typescript-eslint lints outside `tsconfig.json` (`eslint.config.mts`, `tests/*.test.ts`) Node types while `src/` stays without them.

## Release metadata

- Every [versions.json](../versions.json) entry, including the already-released 1.0.0 to 1.0.2, maps to Obsidian 1.5.1: every release calls `Modal.setTitle`, so a lower entry would offer older Obsidian a release that breaks.

## Source

- `ReadingViewRenderer.decorate` in [src/reading-view.ts](../src/reading-view.ts) uses `el.doc`, not the `activeDocument` that the `obsidianmd/prefer-active-doc` rule suggests: the element's own document stays correct when it renders in an unfocused popout window.
