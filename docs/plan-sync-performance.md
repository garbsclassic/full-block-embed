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
| Startup events | Register vault events in `onLayoutReady`, and on the first index check scan notes whose `mtime` or `ctime` is newer than the last save | Keep `onload` registration | The load-time `create` event for every note marks the whole vault dirty, so the first sync reads every note |
| Debounce | `SYNC_DELAY` 500 ms | 100 ms | Typing leaves 150–250 ms between keys, so 100 ms ran a pass between most keystrokes |
| Persisting | A dirty flag set where persisted state changes; an unchanged index entry is not rewritten | Stringify the whole index per pass to detect changes | Skips both the stringify and the per-keystroke index rewrite |
| Redundant rescans | A dirty note open in an editor refreshes only its stat | Also skip notes the plugin just wrote | An outside edit landing between the plugin's write and the drain would be skipped and leave the index stale |
| Edit scope | An in-app edit queues the blocks whose body changed, appeared, or disappeared | Queue every ID in the note | A disappearing block covers a broken marker, so parse errors still surface |
| Parses per pass | Plan each ID over only the files whose text contains its marker prefix | Thread parse results through `planSync` | A superset filter is a few lines and turns the IDs × files parses into roughly the copy count |

The startup check compares against the time of the last save, so it is a superset: notes changed after that save but before quitting get re-read once. A note copied in with a preserved, older `mtime` is still caught by its `ctime`.

## Steps

### 1. Delete the source-path cache and legacy state

- [x] Remove `savedSourcePaths`, `refreshSavedSourcePaths`, `refreshAllSavedSourcePaths`, and the rename loop
- [x] Remove `LegacyStoredSyncData`, `revisions`, `sourcePaths`, and `storedFingerprint`'s full-content path
- [x] Check: `npm run check` and `npm run build` pass

### 2. Register vault events after layout ready (after 1)

- [x] Move the four `vault.on` registrations into `onLayoutReady`
- [x] Persist the save time and scan newer notes on the first index check
- [ ] Check: unit tests cover a note created while closed; startup in the kb vault doesn't read every note

### 3. Raise the debounce and persist on change (after 2)

- [ ] `SYNC_DELAY` to 500 ms
- [ ] Dirty flag in `save`; `setIndexedPath` returns early for an unchanged entry
- [ ] Check: a pass that changes nothing doesn't call `saveData`

### 4. Skip rescans of notes open in an editor (after 3)

- [ ] `drainDirtyPaths` refreshes stat only for a path with a live document
- [ ] Check: an autosave of an open note doesn't read it from the vault

### 5. Parse once and queue only changed blocks (after 4)

- [ ] Store each observation's block-body map and diff against it
- [ ] Queue changed, added, and removed block IDs for in-app edits
- [ ] Check: typing in one block of a note with several queues only that block; breaking a marker still reports the parse error

### 6. Plan each ID over its own files (after 5)

- [ ] Filter `planSync`'s files per ID; `expandNestedScope` reads and parses only new paths
- [ ] Check: sync-now result unchanged; tests pass

## What this breaks

- Existing data.json files lose `sourcePaths` and any pre-v3 baselines on the next save. Safe because nothing reads `sourcePaths` and the kb vault holds only v3 fingerprints.
- Copies in other panes update up to 500 ms after typing stops instead of 100 ms.

## Verification

- `npm run check` and `npm run build` after each step
- In the kb vault with Hot Reload: typing in a source updates its open reference after a pause; a broken marker shows its issue; restarting Obsidian doesn't trigger a full-vault read
