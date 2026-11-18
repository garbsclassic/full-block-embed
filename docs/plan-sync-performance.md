# Sync performance

Branch: `refactor/sync-performance` · Started: 2026-11-18

## Goal

Typing in a note with shared blocks stops triggering a full sync pass (with disk writes) between keystrokes, startup stops reading the whole vault, and a pass touches only the blocks and files that changed. The sync manager loses state nothing reads.

## Scope

In:

- `src/sync-manager.ts`, `src/sync-state.ts`, `src/blocks.ts` (legacy fingerprint path), `src/plugin.ts` (event registration), and their tests

Out:

- Replacing the timers and `running`/`rerun`/`passDone` flags with one work loop: a separate branch after this one merges, so it refactors the finished behavior
- The editor decoration field's own parse per keystroke ([editor.ts](../src/editor.ts)): measured under 0.5 ms for a 50 KB note

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Legacy data | Drop `sourcePaths`, `revisions`, and full-content baselines | Keep loading them | Nothing reads `sourcePaths`; the kb vault's data is already v3 fingerprints |
| Startup events | Register vault events in `onload` but ignore `create` until `layoutReady`, and on the first index check scan notes whose `mtime` or `ctime` is newer than the saved time | Register everything in `onLayoutReady` (first version, changed after review: it dropped events between load and layout ready); keep `create` live during load | The load-time `create` event for every note marks the whole vault dirty, so the first sync reads every note |
| Debounce | `SYNC_DELAY` 500 ms | 100 ms | Typing leaves 150–250 ms between keys, so 100 ms ran a pass between most keystrokes |
| Persisting | A dirty flag set where persisted state changes; an unchanged index entry is not rewritten | Stringify the whole index per pass to detect changes | Skips both the stringify and the per-keystroke index rewrite |
| Redundant rescans | Keep them (step 4 dropped) | Skip notes the plugin just wrote; skip notes open in an editor | An outside edit landing between the plugin's write and the drain would be skipped and leave the index stale; an open note is already rescanned from its buffer, not the disk |
| Edit scope | An in-app edit queues the blocks whose body changed, appeared, or disappeared; one that changes the note's parse errors queues every ID | Queue every ID in the note | A stray marker outside every block changes no body, so the error comparison catches it |
| Parses per pass | Plan each ID over only the files whose text contains its marker prefix | Thread parse results through `planSync` | A superset filter is a few lines and turns the IDs × files parses into roughly the copy count |

The saved time (`savedAt`) is when the last completed index check started, with nothing left dirty, not when the data was written. A save before the first check of a session keeps the loaded time, so quitting early can't hide notes changed while Obsidian was closed. Advancing the time doesn't trigger a save on its own, so a stale time only means more notes get re-read once. Only a completed index check advances it: dirty-note drains go through the check, a forced rescan resets it to 0 until it finishes, and a failed read keeps it for the rest of the session.

`ctime` is creation time, so a new note copied in with a preserved, older `mtime` is caught. An existing unindexed note overwritten in place with an older `mtime` is not, until it changes again or **Sync now** runs. Catching that would mean storing every note's stat.

## Steps

### 1. Delete the source-path cache and legacy state

- [x] Remove `savedSourcePaths`, `refreshSavedSourcePaths`, `refreshAllSavedSourcePaths`, and the rename loop
- [x] Remove `LegacyStoredSyncData`, `revisions`, `sourcePaths`, and `storedFingerprint`'s full-content path
- [x] Check: `npm run check` and `npm run build` pass

### 2. Register vault events after layout ready (after 1)

- [x] Move the four `vault.on` registrations into `onLayoutReady` (revised in step 7: `onload`, with `create` gated on layout ready)
- [x] Persist the save time and scan newer notes on the first index check
- [ ] Check: unit tests cover a note created while closed; startup in the kb vault doesn't read every note — the unit tests pass and fail when the check is removed; the full-vault read at startup isn't measured in Obsidian, only reasoned from the event registration

### 3. Raise the debounce and persist on change (after 2)

- [x] `SYNC_DELAY` to 500 ms
- [x] Dirty flag in `save`; `setIndexedPath` returns early for an unchanged entry
- [x] Check: a pass that changes nothing doesn't call `saveData`

### 4. Skip rescans of notes open in an editor (after 3)

- [ ] `drainDirtyPaths` refreshes stat only for a path with a live document — dropped: `scanFile` already reads an open note from its editor buffer, not the vault, so skipping it saves one parse (about 0.1 ms for 50 KB). The disk reads happen for notes the plugin wrote, which the Decisions table rules out skipping
- [ ] Check: an autosave of an open note doesn't read it from the vault — dropped with the step

### 5. Parse once and queue only changed blocks (after 3)

- [x] Store each observation's block-body map and diff against it
- [x] Queue changed, added, and removed block IDs for in-app edits
- [x] Check: typing in one block of a note with several queues only that block; breaking a marker still reports the parse error

### 6. Plan each ID over its own files (after 5)

- [x] Filter `planSync`'s files per ID; `expandNestedScope` reads and parses only new paths
- [x] Check: sync-now result unchanged; tests pass. Measured 2026-11-18: planning 100 IDs over 300 notes (one source and two references each) took 157 ms before, 5.7 ms after

### 7. Fix review findings (after 6)

- [x] An in-app edit that changes the note's parse errors re-checks every ID
- [x] Dirty-note drains go through the index check, so only a completed check advances the saved time
- [x] A forced rescan resets the saved time until it completes; a failed read stops it advancing
- [x] Vault events register in `onload`, with `create` ignored until layout ready
- [x] `loadSyncState` keeps only `knownRefs` set to `true`
- [ ] Check: regression tests for each, failing with the fix reverted

## What this breaks

- Existing data.json files lose `sourcePaths` and any pre-v3 baselines on the next save. Safe because nothing reads `sourcePaths` and the kb vault holds only v3 fingerprints.
- Copies in other panes update up to 500 ms after typing stops instead of 100 ms.

## Verification

- `npm run check` and `npm run build` after each step
- In the kb vault with Hot Reload: typing in a source updates its open reference after a pause; a broken marker shows its issue; restarting Obsidian doesn't trigger a full-vault read

Run 2026-11-18 in the kb vault, using scratch notes at the vault root that were deleted afterwards:

- After View → Force Reload, data.json carried `savedAt` and no `sourcePaths`.
- Editing a source block's body in Source mode updated its reference on disk; the note's other block was untouched.
- Typing six characters 300 ms apart into a source produced one write to the closed reference note, after typing stopped. A file watcher polled its mtime every 20 ms.
- Unit tests (93) cover the startup check, the save time, dirty-flag saves, edit scope, the planning filter, and one read per note during scope expansion. Removing the edit-scope narrowing or the startup check makes the matching tests fail.
- Not checked in Obsidian: the broken-marker issue (unit-tested), and whether a cold start reads every note.
