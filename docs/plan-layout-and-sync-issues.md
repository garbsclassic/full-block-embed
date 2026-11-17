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
- Issues are tracked per note path: each sync pass reports and clears only the paths in its scope, and a note's issues clear when its editor loses its last marker (`unobserve` with the note's path; closing a tab passes none). Within a failed pass, `issuesByPath` files an error under the note it names, or under every note in the pass when it names none, so a healthy note sharing a pass isn't left holding another note's error. An interrupted pass has no scope, so it reports under the key `''`, which any successful pass clears. A clean pass for one note no longer hides another note's broken marker.
- Mobile has no status bar, so it shows one toast when the issue list goes from empty to non-empty, and relies on the **Open first shared block sync issue** command to open it. Desktop shows no toast.
- **Synchronize shared blocks now** is an explicit action, so it shows `Sync paused: N issues` when issues remain after it runs and nothing otherwise.
- The non-live-preview branch of `renderPreview` and the `source-editing-line`, `marker-line` and `editing-reference` classes are removed: the CSS that styled them is gone, and `ReferenceEditorWidget` is only built in live preview.
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
- [ ] Reviewer pass over the branch diff

## Verification

- `npm run check`
- Before/after screenshots of live preview and reading view in Obsidian; reference text inset matches a normal paragraph
- Unclosed marker typed by hand: no toast, status bar count, selecting it opens the line, clears once fixed
- `data.json` writes while typing: 4 in ~5s, each ~100ms after a note autosave
- Not verified in Obsidian: deleting a reference shows no toast, and hover controls after the margin trim (synthetic hover didn't trigger them)

## Caveats

- Without the right gutter, hover controls overlap the end of a reference's first line in live preview. Removing the hover controls is the follow-up if that bothers in use.
