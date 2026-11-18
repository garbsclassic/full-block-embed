# Edit references in place

Branch: `refactor/edit-references-in-place` · Started: 2026-11-18

## Goal

Live Preview edits a reference's copied Markdown directly in the note, as Source mode does, so every edit syncs through the one editor-observer path. The embedded source editor, its rendered preview, and its second sync route are removed.

## Decisions

- Live Preview reuses Source mode's decorations: a hover class on the block's first body line and the inline button widget. That widget already existed, so keeping the buttons costs no new code.
- Marker lines show as comments in Live Preview, the same as source blocks always have.
- References get a third button, between open and delete, that converts that one reference to normal text: it removes the reference's marker lines and keeps its Markdown. It reuses the `unwrapBlock` shape, written as one editor transaction so undo restores it.
- Reading mode keeps only open and delete. Adding the new button there means a file-level unwrap like `removeReferenceFromFile`; left out until asked.
- Ctrl/Cmd-click to open the source now works only in Reading mode. In an editor it would compete with Obsidian's own Cmd-click behavior.
- The earlier embedded-editor fixes from this session (preview spacing, hidden markers, click placement, Up/Down to leave) are superseded. They are kept in a stash: `embedded editor fixes, superseded by in-place editing`.

## Steps

- [x] Remove `ReferenceEditorWidget`, `viewportExtension`, `src/embedded-editor.ts`, `SourceEditor.mount`, `renderPreview`, and their CSS
- [x] Decorate references in Live Preview like Source mode
- [x] Add the convert-reference button and `decoupleReferenceInEditor`
- [x] Update README, CHANGELOG, and the stale sync-manager comment
- [x] Verify in the kb vault: Live Preview editing syncs to the source, the three buttons work, and delete and convert can be undone

## Verification

Run 2026-11-18 in the kb vault, using scratch notes at the vault root that were deleted afterwards:

- A destination in Live Preview shows its marker lines as comments and edits as plain text. Typing in its copy updated the source note within 2 seconds.
- The reference's buttons render in order: open source, convert reference to normal text, delete reference. They show on real mouse hover.
- Convert removed only the reference's marker lines and left the source untouched; Cmd+Z restored them.
- Delete removed the whole reference; Cmd+Z restored it.
- Not checked: the open-source button (unchanged code), mobile, and editing a source in Live Preview to update a reference.
