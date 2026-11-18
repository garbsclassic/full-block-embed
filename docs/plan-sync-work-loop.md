# Sync work loop

Branch: `refactor/sync-work-loop` (from `refactor/sync-performance`) · Started: 2026-11-18

## Goal

`BlockSyncManager` serializes its work through one debounced timer and one async loop instead of two timers, the `running`/`rerun`/`passDone` flags, and `indexPromise`. Behavior stays what [plan-sync-performance.md](plan-sync-performance.md) left, pinned by its tests.

## Scope

In:

- `src/sync-manager.ts` (`BlockSyncManager` scheduling) and `tests/sync-manager.test.ts`

Out:

- Queuing open blocks held by notes whose stat changed without a vault event: the loop re-checks the blocks of dirty notes only, as the dirty-note drain did
- Anything in [plan-sync-performance.md](plan-sync-performance.md)'s out-of-scope list

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Loop shape | Each step brings the index up to date, then synchronizes the queued IDs if the timer has fired; it repeats while a full pass is requested, the index is stale, or queued IDs are due | Separate index and sync queues with their own promises | One promise to wait on replaces `indexPromise`, `passDone`, and `rerun` |
| Timer | One timer; every schedule resets it to the newest delay | Keep the earliest deadline | Matches the old sync timer's debounce; a modify event no longer has its own timer |
| Dirty notes | The index update queues the open IDs a dirty note held before or after its rescan | A separate drain that snapshots the dirty paths | Any index update, including one a read method starts, re-checks those blocks; before, a read that drained the dirty notes first left the drain nothing to queue |
| Waiting | `synchronizeAll` and the read methods await the running loop | Readers wait only for the index | One wait point; a read after a pass sees its writes |
| Forced rescan | `synchronizeAll` sets a flag the loop takes on its next step | Join an index check already running | The old join skipped the rescan when a check was in flight |
| Unobserve | Cancel the timer once no block is open | Cancel it when the queue empties | The timer also carries dirty-note drains, which only matter while a block is open |

## Steps

### 1. Replace the scheduling state with the loop

- [x] One `timer`, a `working` promise, and a `fullPass` flag replace `syncTimer`, `dirtyTimer`, `running`, `rerun`, `passDone`, and `indexPromise`
- [x] `updateIndex` merges `ensureIndex` and `prepareIndex`; `refreshChangedFiles` queues the open IDs of dirty notes, replacing `drainDirtyPaths`
- [x] `ConcurrentEditError` re-queues its IDs with the debounce
- [x] Check: `npm run check` and `npm run build` pass; the 98 existing tests pass, with one setup tweak (the held-write `synchronizeAll` test runs the clock after releasing the write, since the rescan now starts after the pass); `src/` is 66 lines added, 92 removed

### 2. Test the loop (after 1)

- [x] Regression tests for the decisions above: a read that drains dirty notes still re-checks their open blocks, a full pass requested during an index check still rescans, readers wait for a running pass
- [x] Check: each new test fails against `refactor/sync-performance` (101 tests; the three new ones fail there). A `ConcurrentEditError` retry test passed on both, so it wasn't kept

## What this breaks

- `getSources`, `findSource`, and `filesForId` wait for a running pass, so a read during a held vault write waits for it.
- A modify event resets the shared timer, so it can push back a pending first pass by up to 500 ms.

## Verification

- `npm run check` and `npm run build`
- Not planned: a run in the kb vault, since the change is internal scheduling the unit tests drive on a virtual clock
