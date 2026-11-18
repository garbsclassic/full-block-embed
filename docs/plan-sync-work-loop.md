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
| Timer | One timer; queuing IDs resets it to the newest delay, and a modify event arms it only when none is pending | Let modify events reset it too (first version, changed after review) | Matches the old sync timer's debounce; a stream of outside edits under 500 ms apart would otherwise hold back every queued pass |
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
- [x] Check: each new test fails against `refactor/sync-performance` (101 tests; the three new ones fail there). A `ConcurrentEditError` retry test passed on both, so it was dropped here and restored in step 3

### 3. Fix review findings (after 2)

- [x] A modify event arms the timer only when none is pending
- [x] `work()` clears `working` in its own `finally`, so a `synchronizeAll` right after a loop ends can't join the finished run and skip its full pass
- [x] Check: regression tests for both, failing with the fix reverted; a `ConcurrentEditError` retry test kept as a characterization test (104 tests; `src/` is 68 lines added, 91 removed against `refactor/sync-performance`)

## What this breaks

- `getSources`, `findSource`, and `filesForId` wait for a running pass, so a read during a held vault write waits for it.
- During a stream of outside edits, open blocks are re-checked every 500 ms instead of once the stream stops.
- A failed save during an index update still leaves queued IDs waiting for the next schedule or read, as before; the loop now keeps them queued instead of dropping them.

## Verification

- `npm run check` and `npm run build`
- Not planned: a run in the kb vault, since the change is internal scheduling the unit tests drive on a virtual clock
