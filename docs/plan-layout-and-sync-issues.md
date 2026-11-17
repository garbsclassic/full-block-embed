# Layout styles and sync issues

Branch: `fix/layout-styles-and-sync-toasts` · Started: 2026-11-16

- [Goal](#goal)
- [Decisions](#decisions)
- [Steps](#steps)
- [Verification](#verification)
- [Caveats](#caveats)

## Goal

Shared blocks render with Obsidian's own layout in live preview and reading view, and sync issues no longer stack blocking toasts while markers are typed or removed by hand.

## Decisions

- Remove only layout-affecting rules from `styles.css` (gutters, highlight backgrounds, source-preview typography). Keep the hover control overlay and the embedded-editor reset, which keeps the inline editor from rendering as a full pane.
- Keep the live-preview margin trim. Without it the rendered reference sat ~15px below its line number with an extra ~15px gap after it; with it, the hover controls can overlap the end of the first line, which was accepted.
- Sync issues show in one status bar item (`Sync paused: N issues`) that clears itself; selecting it opens the first issue.
- Issues are keyed by what a later pass re-checks (`src/sync-issues.ts`), so a pass clears only what it checked:
  - Parse errors go under their note's path. Every pass parses every note in its scope first, so it reports or clears each of those paths.
  - Block errors (no single source, conflicting or outside edits, nesting cycles) go under `block:<id>`. A pass clears them only for the IDs it reached, so a clean pass for `x` no longer hides a broken `y` in the same notes.
  - An interrupted pass has no scope, so it reports under `''`. Only a clean pass clears that key.
  - When a path or block ID leaves the marker index (note deleted, its last marker removed in an editor or outside Obsidian, or gone after a forced rescan), its issues clear, since no later pass covers it. Closing a tab clears nothing.
  - Renaming a note moves its issues to the new path and repoints messages that name the old path, so a closed note's issue stays visible.
- Mobile has no status bar, so it shows one toast when the issue list goes from empty to non-empty, and relies on the **Open first shared block sync issue** command to open it. Desktop shows no toast.
- **Synchronize shared blocks now** is an explicit action, so it shows `Sync paused: N issues` when issues remain after it runs and nothing otherwise. It waits for a pass that is already running, then runs its own, so the toast reflects the full pass rather than the state before it.
- The non-live-preview branch of `renderPreview` and the `source-editing-line`, `marker-line` and `editing-reference` classes are removed: the CSS that styled them is gone, and `ReferenceEditorWidget` is only built in live preview. For the same reason the widget no longer passes a `livePreview` flag down to the embedded editor, which always opens in live preview.
- Success toasts (`Deleted reference`, `Converted … to normal text`) are dropped; failure toasts for explicit actions stay because they fire once per action.
- `persist()` skips `saveData` when the serialized data is unchanged, and runs one save at a time so `lastSaved` always matches the newest save requested. Obsidian's `saveData` does not surface write errors, so a failed write is not retried. Every sync pass, including failed ones, used to persist. `data.json` still changes once per note autosave (~2s) because the index stores each note's `mtime` and `size`.
- Styles and toasts had no meaningful CPU cost; their cost was layout and UX.

## Steps

- [x] Remove layout-affecting styles
- [x] Status bar indicator replaces sync-issue toasts
- [x] Drop success toasts
- [x] README and CHANGELOG
- [x] Skip unchanged `saveData` writes
- [x] Verify in the kb vault: before/after screenshots, typed broken marker, `data.json` mtime
- [x] Reviewer pass over the branch diff
- [x] Review fix: a clean pass for one id clears another id's issue in the same notes (key per-id errors by id)
- [x] Review fix: clear a path's issues whenever the index drops it, not only on delete, rename or unobserve
- [x] Review fix: only a clean pass clears the interrupted-pass `''` key
- [x] Review fix: rename moves a closed note's issues to its new path instead of clearing them
- [x] Review fix: drop the always-true `livePreview` parameter
- [x] Review fix: tests for the tab-switch unobserve case and the plugin's visible issue list

## Verification

- `npm run check`
- Before/after screenshots of live preview and reading view in Obsidian; reference text inset matches a normal paragraph
- Unclosed marker typed by hand: no toast, status bar count, selecting it opens the line, clears once fixed
- `data.json` writes while typing: 4 in ~5s, each ~100ms after a note autosave
- Not verified in Obsidian: deleting a reference shows no toast, and hover controls after the margin trim (synthetic hover didn't trigger them)
- The checks above predate `b067cde` and the review fixes; the issue keying, rename and index-drop clearing are covered by unit tests only

## Caveats

- Without the right gutter, hover controls overlap the end of a reference's first line in live preview. Removing the hover controls is the follow-up if that bothers in use.
- Removing a source marker in an editor runs no pass, so a reference elsewhere that lost its source shows no issue until that block syncs again or **Synchronize shared blocks now** runs. This predates the branch.
- A closed note fixed while no shared block is open stays listed until **Synchronize shared blocks now**, because `markModified` only drains dirty paths while blocks are active. This also predates the branch.
- The tests mirror the plugin's three-line callback wiring into `SyncIssues` rather than exercising `plugin.ts`.
