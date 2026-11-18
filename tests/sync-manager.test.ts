import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { createJiti } from 'jiti';
import type { Plugin } from 'obsidian';
import type * as ObsidianStub from './stubs/obsidian.ts';
import type * as SyncIssuesModule from '../src/sync-issues.ts';
import type * as SyncManagerModule from '../src/sync-manager.ts';

const obsidianStub = fileURLToPath(new URL('./stubs/obsidian.ts', import.meta.url));
// One loader for both modules: the manager's `obsidian` import must resolve to the same TFile
// class the fake vault instantiates, or the manager's `instanceof TFile` checks reject every note.
const loader = createJiti(import.meta.url, { alias: { obsidian: obsidianStub } });
const { TFile } = await loader.import<typeof ObsidianStub>(obsidianStub);
const { BlockSyncManager } = await loader.import<typeof SyncManagerModule>(
	'../src/sync-manager.ts',
);
const { SyncIssues } = await loader.import<typeof SyncIssuesModule>('../src/sync-issues.ts');
type VaultFile = ObsidianStub.TFile & { path: string };
type ObsidianFile = Parameters<SyncManagerModule.BlockSyncManager['markModified']>[0];

const FINGERPRINT = 'v1:12:0123456789abcdef0123456789abcdef';
const OTHER_FINGERPRINT = 'v1:13:fedcba9876543210fedcba9876543210';

const BROKEN_A = 'intro\n<!--#foo+-->\nbody\n';
const PLAIN_A = 'intro\nbody\n';
const BROKEN_B = '<!--#bar+-->\nb\n';
const FIXED_B = '<!--#bar+-->\nb\n<!--#bar/-->\n';
const CLEAN_C = '<!--#baz+-->\nc\n<!--#baz/-->\n<!--#baz=-->\nc\n<!--#baz/-->\n';
const UNSYNCED_A = '<!--#foo+-->\nnew\n<!--#foo/-->\n<!--#foo=-->\n<!--#foo/-->\n';
const X_SOURCE = '<!--#x+-->\nx\n<!--#x/-->\n';
const Y_SOURCE = '<!--#y+-->\ny\n<!--#y/-->\n';
const A_FOO_ERROR = 'A.md:2: unclosed source block foo (closing marker is missing)';
const B_FOO_ERROR = 'B.md:2: unclosed source block foo (closing marker is missing)';
const B_BAR_ERROR = 'B.md:1: unclosed source block bar (closing marker is missing)';
const X_NO_SOURCE_ERROR = 'x: expected exactly one source, found 0';
const Y_NO_SOURCE_ERROR = 'y: expected exactly one source, found 0';
const N_NO_SOURCE_ERROR = 'n: expected exactly one source, found 0';
const CYCLE_A_ERROR = 'a: circular nested shared blocks (a -> b -> a)';

function storedWith(hashes: Record<string, string>) {
	return { version: 3, hashes, knownRefs: {}, files: {} };
}

// setImmediate runs after every pending microtask, so queued work reaches its next await.
function flushEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

// The order of keys inside one callback carries no meaning, so each list is compared sorted.
function sortedKeys(calls: string[][]): string[][] {
	return calls.map((keys) => [...keys].sort());
}

// Events are typed with Obsidian's TFile, but the manager reads only the path the stub carries.
function eventFile(path: string): ObsidianFile {
	return Object.assign(new TFile(), { path }) as unknown as ObsidianFile;
}

// In-memory vault covering the calls a synchronization pass makes: lookup, listing, read, process.
function createVault(notes: Record<string, string>, { holdProcess = false } = {}) {
	const texts = new Map(Object.entries(notes));
	const heldProcesses: Array<() => void> = [];
	const processFailures: Error[] = [];
	let holding = holdProcess;
	const fileAt = (path: string): VaultFile =>
		Object.assign(new TFile(), {
			path,
			extension: 'md',
			stat: { mtime: 0, size: texts.get(path)?.length ?? 0 },
		});
	return {
		getAbstractFileByPath: (path: string) => (texts.has(path) ? fileAt(path) : null),
		getMarkdownFiles: () => [...texts.keys()].sort().map(fileAt),
		read: async (file: VaultFile) => texts.get(file.path) ?? '',
		process: async (file: VaultFile, update: (text: string) => string) => {
			// A held write keeps its pass running until completeProcess releases it.
			if (holding) await new Promise<void>((complete) => heldProcesses.push(complete));
			const failure = processFailures.shift();
			if (failure) throw failure;
			const next = update(texts.get(file.path) ?? '');
			texts.set(file.path, next);
			return next;
		},
		// Stands in for saving an edit, so later passes read the new text from the vault.
		write: (path: string, text: string) => {
			texts.set(path, text);
		},
		// Stands in for a note deleted or renamed away, so a later full scan no longer finds it.
		remove: (path: string) => {
			texts.delete(path);
		},
		// The next write rejects, as a failed vault write does, and leaves the note unchanged.
		failNextProcess: (error: Error) => {
			processFailures.push(error);
		},
		heldProcesses,
		completeProcess: () => {
			holding = false;
			for (const complete of heldProcesses) complete();
		},
	};
}

function createManager({ holdSaves = false, vault = createVault({}) } = {}) {
	const saveCalls: unknown[] = [];
	const failures: Error[] = [];
	const heldSaves: Array<() => void> = [];
	// Each report is the callback's Map as a plain object, so assertions compare literal values.
	const issues: Array<Record<string, string[]>> = [];
	const clears: string[][] = [];
	const renames: Array<[string, string]> = [];
	// Fed the same way the plugin feeds its status bar, so `visible.list` is what the user sees.
	const visible = new SyncIssues();
	const plugin = {
		app: { vault },
		saveData: async (data: unknown) => {
			// Snapshot the payload as Obsidian would persist it, since the manager keeps
			// mutating the maps it passed in. The save time differs per run, so it's dropped.
			const snapshot = structuredClone(data) as Record<string, unknown>;
			delete snapshot.savedAt;
			saveCalls.push(snapshot);
			if (holdSaves)
				await new Promise<void>((complete) => heldSaves.push(complete));
			const failure = failures.shift();
			if (failure) throw failure;
		},
	} as unknown as Plugin;
	const manager = new BlockSyncManager(plugin, {
		onIssues: (reported) => {
			issues.push(Object.fromEntries(reported));
			visible.report(reported);
		},
		onClearIssues: (keys) => {
			clears.push(keys);
			visible.clear(keys);
		},
		onRenameIssues: (from, to) => {
			renames.push([from, to]);
			visible.rename(from, to);
		},
		onFilesChanged: () => undefined,
	});
	return {
		manager,
		vault,
		saveCalls,
		issues,
		clears,
		renames,
		visible,
		failNextSave: (error: Error) => {
			failures.push(error);
		},
		// Completes held saves by call order; with no index, completes every pending one.
		completeSave: (index?: number) => {
			const targets = index === undefined ? heldSaves : [heldSaves[index]];
			for (const complete of targets) complete?.();
		},
	};
}

function useVirtualClock(t: TestContext): void {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	// The manager schedules through window.setTimeout, which is the global object in Obsidian.
	// Node has no window global, so removing it again restores the starting state.
	Reflect.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
	t.after(() => Reflect.deleteProperty(globalThis, 'window'));
}

// Fires pending timers and lets each promise chain reach its next timer. The round limit turns
// a pass that never reports into a failing assertion instead of a hang.
async function runUntil(t: TestContext, done: () => boolean): Promise<void> {
	for (let round = 0; round < 50; round++) {
		t.mock.timers.runAll();
		await flushEventLoop();
		if (done()) return;
	}
	assert.fail('the synchronization pass did not report on the virtual clock');
}

function clockTest(name: string, body: (t: TestContext) => Promise<void>): void {
	test(name, { timeout: 5_000 }, async (t) => {
		useVirtualClock(t);
		await body(t);
	});
}

async function synchronizeAllOnClock(
	t: TestContext,
	manager: SyncManagerModule.BlockSyncManager,
): Promise<void> {
	let settled = false;
	const full = manager.synchronizeAll().then(() => {
		settled = true;
	});
	await runUntil(t, () => settled);
	await full;
}

test('first persist after construction calls saveData even when nothing changed', async () => {
	const { manager, saveCalls } = createManager();

	await manager.forget('example');

	assert.deepEqual(saveCalls, [storedWith({})]);
});

test('persist skips saveData when the serialized state matches the last save', async () => {
	const { manager, saveCalls } = createManager();
	manager.load(storedWith({ example: FINGERPRINT }));

	await manager.forget('unknown');
	await manager.forget('unknown');

	assert.deepEqual(saveCalls, [storedWith({ example: FINGERPRINT })]);
});

test('persist saves again once the stored state differs from the last save', async () => {
	const { manager, saveCalls } = createManager();
	manager.load(storedWith({ example: FINGERPRINT }));

	await manager.forget('unknown');
	await manager.forget('example');

	assert.deepEqual(saveCalls, [
		storedWith({ example: FINGERPRINT }),
		storedWith({}),
	]);
});

test('failed saveData leaves the state unsaved so the next persist retries it', async () => {
	const { manager, saveCalls, failNextSave } = createManager();
	manager.load(storedWith({ example: FINGERPRINT }));
	failNextSave(new Error('disk full'));

	await assert.rejects(manager.forget('example'), { message: 'disk full' });
	await manager.forget('unknown');
	await manager.forget('unknown');

	assert.deepEqual(saveCalls, [storedWith({}), storedWith({})]);
});

test('queued persist waits for the held save, then writes the newest state', async () => {
	const { manager, saveCalls, completeSave } = createManager({ holdSaves: true });
	manager.load(storedWith({ example: FINGERPRINT }));

	const first = manager.forget('unknown');
	await flushEventLoop();
	assert.equal(saveCalls.length, 1);

	const second = manager.forget('example');
	manager.load(storedWith({ other: OTHER_FINGERPRINT }));
	await flushEventLoop();
	assert.equal(saveCalls.length, 1);

	completeSave(0);
	await first;
	await flushEventLoop();
	assert.equal(saveCalls.length, 2);
	completeSave();
	await second;

	assert.deepEqual(saveCalls, [
		storedWith({ example: FINGERPRINT }),
		storedWith({ other: OTHER_FINGERPRINT }),
	]);
});

test('unchanged queued persist resolves after the held save without saveData', async () => {
	const { manager, saveCalls, completeSave } = createManager({ holdSaves: true });
	manager.load(storedWith({ example: FINGERPRINT }));

	const first = manager.forget('unknown');
	await flushEventLoop();
	assert.equal(saveCalls.length, 1);

	let secondSettled = false;
	const second = manager.forget('unknown').then(() => {
		secondSettled = true;
	});
	await flushEventLoop();
	assert.equal(secondSettled, false);

	completeSave(0);
	await first;
	await flushEventLoop();
	assert.equal(secondSettled, true);
	await second;

	assert.deepEqual(saveCalls, [storedWith({ example: FINGERPRINT })]);
});

test('rejected save does not block the queue; the next persist retries', async () => {
	const { manager, saveCalls, completeSave, failNextSave } = createManager({
		holdSaves: true,
	});
	manager.load(storedWith({ example: FINGERPRINT }));
	failNextSave(new Error('disk full'));

	const first = manager.forget('unknown');
	await flushEventLoop();
	assert.equal(saveCalls.length, 1);

	const second = manager.forget('unknown');
	await flushEventLoop();
	assert.equal(saveCalls.length, 1);

	completeSave(0);
	await assert.rejects(first, { message: 'disk full' });
	await flushEventLoop();
	assert.equal(saveCalls.length, 2);
	completeSave();
	await second;

	const third = manager.forget('unknown');
	await flushEventLoop();
	assert.equal(saveCalls.length, 2);
	await third;

	assert.deepEqual(saveCalls, [
		storedWith({ example: FINGERPRINT }),
		storedWith({ example: FINGERPRINT }),
	]);
});

clockTest('unobserving with the note path clears that note issue', async (t) => {
	const editor = {};
	const { manager, issues, clears, visible } = createManager({
		vault: createVault({ 'A.md': BROKEN_A }),
	});
	manager.observe(editor, 'A.md', BROKEN_A);
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(issues, [{ 'A.md': [A_FOO_ERROR] }]);

	// The editor unobserves with the note path once its document no longer contains a marker.
	manager.unobserve(editor, 'A.md');

	// A.md held the only foo marker, so foo leaves the index too and its key clears with it.
	assert.deepEqual(sortedKeys(clears), [['A.md', 'block:foo']]);
	assert.deepEqual(visible.list, []);
});

clockTest('observing a note without markers clears its earlier issue', async (t) => {
	const editor = {};
	const { manager, issues, clears, visible } = createManager({
		vault: createVault({ 'A.md': BROKEN_A }),
	});
	manager.observe(editor, 'A.md', BROKEN_A);
	await runUntil(t, () => issues.length === 1);

	manager.observe(editor, 'A.md', PLAIN_A);

	assert.deepEqual(sortedKeys(clears), [['A.md', 'block:foo']]);
	assert.deepEqual(visible.list, []);
});

clockTest("a clean pass for one note does not clear another note's issue", async (t) => {
	const brokenOwner = {};
	const cleanOwner = {};
	const { manager, issues, clears, visible } = createManager({
		vault: createVault({ 'B.md': BROKEN_B, 'C.md': CLEAN_C }),
	});
	// C is observed only after B's failure is reported, so C's pass is separate and clean.
	manager.observe(brokenOwner, 'B.md', BROKEN_B);
	await runUntil(t, () => issues.length === 1);

	manager.observe(cleanOwner, 'C.md', CLEAN_C);
	await runUntil(t, () => clears.length === 1);

	assert.deepEqual(issues, [{ 'B.md': [B_BAR_ERROR] }]);
	assert.deepEqual(sortedKeys(clears), [['', 'C.md', 'block:baz']]);
	assert.deepEqual(visible.list, [B_BAR_ERROR]);
});

clockTest('notes observed in the same tick each report only their own issues', async (t) => {
	const brokenOwner = {};
	const cleanOwner = {};
	const { manager, issues, clears, vault, visible } = createManager({
		vault: createVault({ 'B.md': BROKEN_B, 'C.md': CLEAN_C }),
	});
	// Both notes join one synchronization pass, and B's unclosed marker fails that pass.
	manager.observe(brokenOwner, 'B.md', BROKEN_B);
	manager.observe(cleanOwner, 'C.md', CLEAN_C);
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(issues, [{ 'B.md': [B_BAR_ERROR], 'C.md': [] }]);

	vault.write('B.md', FIXED_B);
	manager.observe(brokenOwner, 'B.md', FIXED_B);
	await runUntil(t, () => clears.length === 1);

	assert.deepEqual(sortedKeys(clears), [['', 'B.md', 'block:bar']]);
	assert.deepEqual(issues, [{ 'B.md': [B_BAR_ERROR], 'C.md': [] }]);
	assert.deepEqual(visible.list, []);
});

clockTest('unobserving without a path clears nothing; with the path it clears', async (t) => {
	const tab = {};
	const editor = {};
	const { manager, issues, clears, visible } = createManager({
		vault: createVault({ 'A.md': BROKEN_A, 'B.md': BROKEN_B }),
	});
	manager.observe(tab, 'A.md', BROKEN_A);
	await runUntil(t, () => issues.length === 1);
	manager.observe(editor, 'B.md', BROKEN_B);
	await runUntil(t, () => issues.length === 2);
	assert.deepEqual(issues, [{ 'A.md': [A_FOO_ERROR] }, { 'B.md': [B_BAR_ERROR] }]);

	// Closing a tab passes no note path, and A.md keeps its marker, so its issue must stay.
	manager.unobserve(tab);
	assert.deepEqual(clears, []);
	assert.deepEqual([...visible.list].sort(), [A_FOO_ERROR, B_BAR_ERROR]);

	manager.unobserve(editor, 'B.md');
	assert.deepEqual(sortedKeys(clears), [['B.md', 'block:bar']]);
	assert.deepEqual(visible.list, [A_FOO_ERROR]);
});

clockTest("removing a source's last marker re-checks copies; closing a tab does not", async (t) => {
	const sourceOwner = {};
	const referenceOwner = {};
	const A = '<!--#x+-->\nhello\n<!--#x/-->\n';
	const B = '<!--#x=-->\nhello\n<!--#x/-->\n';
	const { manager, vault, issues, clears, visible } = createManager({
		vault: createVault({ 'A.md': A, 'B.md': B }),
	});
	manager.observe(referenceOwner, 'B.md', B);
	manager.observe(sourceOwner, 'A.md', A);
	await runUntil(t, () => clears.length === 1);
	assert.deepEqual(visible.list, []);

	// Closing A's tab while its marker stays on disk must not re-check x.
	manager.unobserve(sourceOwner);
	t.mock.timers.runAll();
	await flushEventLoop();
	assert.deepEqual(issues, []);
	assert.deepEqual(sortedKeys(clears), [['', 'A.md', 'B.md', 'block:x']]);

	manager.observe(sourceOwner, 'A.md', A);
	await runUntil(t, () => clears.length === 2);

	// B still shows x, which now has no source, so the pass must report it.
	vault.write('A.md', 'plain\n');
	manager.observe(sourceOwner, 'A.md', 'plain\n');
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(visible.list, [X_NO_SOURCE_ERROR]);
});

clockTest('a marker-free observe with no earlier observation clears nothing', async () => {
	const owner = {};
	const { manager, clears } = createManager();

	manager.observe(owner, 'Plain.md', PLAIN_A);
	assert.deepEqual(clears, []);

	// The same plain-text observe does clear once this owner has observed a marker in that note.
	manager.observe(owner, 'Plain.md', BROKEN_A);
	manager.observe(owner, 'Plain.md', PLAIN_A);
	assert.deepEqual(sortedKeys(clears), [['Plain.md', 'block:foo']]);
});

clockTest('deleting a note clears the issues it reported under its path', async (t) => {
	const owner = {};
	const { manager, issues, clears, visible } = createManager({
		vault: createVault({ 'B.md': BROKEN_B }),
	});
	manager.observe(owner, 'B.md', BROKEN_B);
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(issues, [{ 'B.md': [B_BAR_ERROR] }]);
	// The editor showing the note closes first, so no later pass covers the deleted path.
	manager.unobserve(owner);

	manager.markDeleted(eventFile('B.md'));

	assert.deepEqual(sortedKeys(clears), [['B.md', 'block:bar']]);
	assert.deepEqual(visible.list, []);
});

clockTest('renaming a note moves its issues to the new path and clears nothing', async (t) => {
	const owner = {};
	const { manager, issues, clears, renames } = createManager({
		vault: createVault({ 'B.md': BROKEN_B }),
	});
	manager.observe(owner, 'B.md', BROKEN_B);
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(issues, [{ 'B.md': [B_BAR_ERROR] }]);
	manager.unobserve(owner);

	manager.markRenamed(eventFile('Renamed.md'), 'B.md');

	assert.deepEqual(renames, [['B.md', 'Renamed.md']]);
	assert.deepEqual(clears, []);
});

clockTest('synchronizeAll waits for a running pass, then covers every note', async (t) => {
	const brokenOwner = {};
	const syncingOwner = {};
	const vault = createVault({ 'A.md': UNSYNCED_A, 'B.md': BROKEN_B }, { holdProcess: true });
	const { manager, issues, clears, visible } = createManager({ vault });
	manager.observe(brokenOwner, 'B.md', BROKEN_B);
	await runUntil(t, () => issues.length === 1);

	// A's empty copy takes the source text, so its pass stops at that write until released.
	manager.observe(syncingOwner, 'A.md', UNSYNCED_A);
	await runUntil(t, () => vault.heldProcesses.length === 1);
	vault.write('B.md', FIXED_B);

	let settled = false;
	const full = manager.synchronizeAll().then(() => {
		settled = true;
	});
	// The index scan yields through the virtual clock once its reads settle, so the timer is
	// registered only after one flush. A synchronizeAll that does not wait would settle by now.
	await flushEventLoop();
	t.mock.timers.runAll();
	await flushEventLoop();
	assert.equal(settled, false);
	assert.deepEqual(sortedKeys(clears), [['', 'A.md', 'block:foo']]);

	vault.completeProcess();
	await full;

	assert.deepEqual(issues, [{ 'B.md': [B_BAR_ERROR] }]);
	assert.deepEqual(sortedKeys(clears), [
		['', 'A.md', 'block:foo'],
		['', 'A.md', 'B.md', 'block:bar', 'block:foo'],
	]);
	assert.deepEqual(visible.list, []);
});

clockTest('a clean pass for block x keeps block y issue visible in the shared notes', async (t) => {
	const referenceOwner = {};
	const sourceOwner = {};
	const A = '<!--#x+-->\nhello\n<!--#x/-->\n';
	const B = '<!--#x=-->\nhello\n<!--#x/-->\n<!--#y=-->\nref\n<!--#y/-->\n';
	const { manager, issues, clears, visible } = createManager({
		vault: createVault({ 'A.md': A, 'B.md': B }),
	});
	// Blocks run in ID order, so x finishes clean before y fails with no source.
	manager.observe(referenceOwner, 'B.md', B);
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(issues, [
		{ 'A.md': [], 'B.md': [], 'block:x': [], 'block:y': [Y_NO_SOURCE_ERROR] },
	]);
	assert.deepEqual(visible.list, [Y_NO_SOURCE_ERROR]);

	// A pass for x alone covers A.md and B.md, but it must not hide y's issue in B.md.
	manager.observe(sourceOwner, 'A.md', A);
	await runUntil(t, () => clears.length === 1);

	assert.deepEqual(sortedKeys(clears), [['', 'A.md', 'B.md', 'block:x']]);
	assert.deepEqual(visible.list, [Y_NO_SOURCE_ERROR]);
});

clockTest('an outside edit removing the last reference marker clears its issue', async (t) => {
	const owner = {};
	const S = '<!--#z+-->\nsrc\n<!--#z/-->\n';
	const P = 'x\n<!--#z=-->\nstale\n';
	const { manager, vault, issues, clears, visible } = createManager({
		vault: createVault({ 'P.md': P, 'S.md': S }),
	});
	manager.observe(owner, 'S.md', S);
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(visible.list, [
		'P.md:2: unclosed reference block z (closing marker is missing)',
	]);

	// No editor shows P, so its edit reaches the manager only as a modified-file event.
	vault.write('P.md', 'plain\n');
	manager.markModified(eventFile('P.md'));
	await runUntil(t, () => clears.length > 0);

	assert.deepEqual(visible.list, []);
	await runUntil(t, () => clears.length === 2);
	assert.deepEqual(sortedKeys(clears), [['P.md'], ['', 'S.md', 'block:z']]);
});

clockTest('a forced rescan clears the issue of a note whose marker vanished', async (t) => {
	const owner = {};
	const S = '<!--#z+-->\nsrc\n<!--#z/-->\n';
	const P = 'x\n<!--#z=-->\nstale\n';
	const { manager, vault, issues, clears, visible } = createManager({
		vault: createVault({ 'P.md': P, 'S.md': S }),
	});
	manager.observe(owner, 'S.md', S);
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(visible.list, [
		'P.md:2: unclosed reference block z (closing marker is missing)',
	]);

	// No modified-file event reaches the manager, so only the full rescan can notice P's change.
	vault.write('P.md', 'plain\n');
	let settled = false;
	const full = manager.synchronizeAll().then(() => {
		settled = true;
	});
	await runUntil(t, () => settled);
	await full;

	assert.deepEqual(sortedKeys(clears), [['P.md'], ['', 'S.md', 'block:z']]);
	assert.deepEqual(visible.list, []);
});

clockTest('an interrupted pass keeps its issue until a clean pass clears it', async (t) => {
	t.mock.method(console, 'error', () => undefined);
	const referenceOwner = {};
	const bOwner = {};
	const R = '<!--#r+-->\nr\n<!--#r/-->\n';
	const X = '<!--#xx+-->\nx\n<!--#xx/-->\n';
	// The empty reference takes the source text, so the pass has a write to make in B.md.
	const B = '<!--#bar+-->\nb\n<!--#bar/-->\n<!--#bar=-->\n<!--#bar/-->\n';
	const { manager, vault, issues, clears, visible } = createManager({
		vault: createVault({ 'B.md': B, 'R.md': R, 'X.md': X }),
	});
	manager.observe(referenceOwner, 'R.md', R);
	await runUntil(t, () => clears.length === 1);

	// B's write rejects after its pass has cleared its own keys, so the pass ends interrupted.
	vault.failNextProcess(new Error('disk offline'));
	manager.observe(bOwner, 'B.md', B);
	await runUntil(t, () => issues.length === 1);
	const interrupted = 'Synchronization interrupted: Error: disk offline';
	assert.deepEqual(issues, [{ '': [interrupted] }]);
	assert.deepEqual(visible.list, [interrupted]);

	manager.markDeleted(eventFile('X.md'));
	assert.deepEqual(sortedKeys(clears.slice(-1)), [['X.md', 'block:xx']]);
	assert.deepEqual(visible.list, [interrupted]);

	manager.unobserve(referenceOwner, 'R.md');
	assert.deepEqual(sortedKeys(clears.slice(-1)), [['R.md', 'block:r']]);
	assert.deepEqual(visible.list, [interrupted]);

	// The write succeeds now, so the full pass is clean and clears the interrupted key.
	let settled = false;
	const full = manager.synchronizeAll().then(() => {
		settled = true;
	});
	await runUntil(t, () => settled);
	await full;

	assert.deepEqual(visible.list, []);
});

clockTest('renaming a closed note repoints only its own parse error', async (t) => {
	const owner = {};
	const otherOwner = {};
	const P = 'intro\n<!--#foo+-->\nbody\n';
	const C = 'intro\n<!--#qux+-->\nbody\n';
	const { manager, issues, clears, renames, visible } = createManager({
		vault: createVault({ 'P.md': P, 'C.md': C }),
	});
	manager.observe(owner, 'P.md', P);
	manager.observe(otherOwner, 'C.md', C);
	await runUntil(t, () => issues.length === 1);
	manager.unobserve(owner);
	manager.unobserve(otherOwner);
	assert.deepEqual(visible.list.sort(), [
		'C.md:2: unclosed source block qux (closing marker is missing)',
		'P.md:2: unclosed source block foo (closing marker is missing)',
	]);

	manager.markRenamed(eventFile('Q.md'), 'P.md');

	assert.deepEqual(renames, [['P.md', 'Q.md']]);
	assert.deepEqual(clears, []);
	assert.deepEqual(visible.list.sort(), [
		'C.md:2: unclosed source block qux (closing marker is missing)',
		'Q.md:2: unclosed source block foo (closing marker is missing)',
	]);
});

clockTest('a tab that moves from a broken note to a marker-free one clears nothing', async (t) => {
	const tab = {};
	const R = '<!--#r+-->\nr\n<!--#r/-->\n';
	const { manager, issues, clears, visible } = createManager({
		vault: createVault({ 'P.md': BROKEN_A, 'R.md': R }),
	});
	manager.observe(tab, 'P.md', BROKEN_A);
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(visible.list, [
		'P.md:2: unclosed source block foo (closing marker is missing)',
	]);

	// R stays indexed from disk, so clearing under the wrong path would drop it as well.
	manager.unobserve(tab, 'R.md');

	assert.deepEqual(clears, []);
	assert.deepEqual(visible.list, [
		'P.md:2: unclosed source block foo (closing marker is missing)',
	]);

	// Unobserving on P itself clears it, so the empty result above is not a no-op unobserve.
	const editor = {};
	manager.observe(editor, 'P.md', BROKEN_A);
	manager.unobserve(editor, 'P.md');

	assert.deepEqual(sortedKeys(clears), [['P.md', 'block:foo']]);
	assert.deepEqual(visible.list, []);
});

clockTest('a marker typed by hand reports only the open ID, then clears', async (t) => {
	const editor = {};
	const { manager, vault, issues, clears, visible } = createManager({
		vault: createVault({ 'A.md': Y_SOURCE }),
	});
	const reports = () => issues.length + clears.length;
	manager.observe(editor, 'A.md', Y_SOURCE);
	await runUntil(t, () => clears.length === 1);

	// Each keystroke's pass ends in one report, so the next keystroke waits for it.
	const keystrokes: Array<[string, string[]]> = [
		[`${Y_SOURCE}<!--#n\n`, ['n: expected exactly one source, found 0']],
		[`${Y_SOURCE}<!--#ne\n`, ['ne: expected exactly one source, found 0']],
		[`${Y_SOURCE}<!--#new\n`, ['new: expected exactly one source, found 0']],
		[`${Y_SOURCE}<!--#new+-->\nc\n<!--#new/-->\n`, []],
	];
	for (const [text, shown] of keystrokes) {
		vault.write('A.md', text);
		manager.observe(editor, 'A.md', text, undefined, true);
		const mark = reports();
		await runUntil(t, () => reports() > mark);
		assert.deepEqual(visible.list, shown);
	}

	await synchronizeAllOnClock(t, manager);
	assert.deepEqual(visible.list, []);
});

clockTest('deleting a whole source block leaves no issue for the removed ID', async (t) => {
	const editor = {};
	const { manager, vault, issues, clears, visible } = createManager({
		vault: createVault({ 'A.md': X_SOURCE + Y_SOURCE }),
	});
	const reports = () => issues.length + clears.length;
	manager.observe(editor, 'A.md', X_SOURCE + Y_SOURCE);
	await runUntil(t, () => clears.length === 1);

	// The x block goes in one edit, so x leaves the index as soon as the edit is observed.
	vault.write('A.md', Y_SOURCE);
	manager.observe(editor, 'A.md', Y_SOURCE, undefined, true);
	const mark = reports();
	await runUntil(t, () => reports() > mark);
	assert.deepEqual(visible.list, []);

	await synchronizeAllOnClock(t, manager);
	assert.deepEqual(visible.list, []);
});

clockTest('renaming then deleting a closed broken note clears its parse error', async (t) => {
	const { manager, vault, visible } = createManager({
		vault: createVault({ 'A.md': BROKEN_A }),
	});
	await synchronizeAllOnClock(t, manager);
	assert.deepEqual(visible.list, [A_FOO_ERROR]);

	// No editor shows the note, so the rename and the delete arrive as vault events.
	vault.remove('A.md');
	vault.write('B.md', BROKEN_A);
	manager.markRenamed(eventFile('B.md'), 'A.md');
	assert.deepEqual(visible.list, [B_FOO_ERROR]);

	vault.remove('B.md');
	manager.markDeleted(eventFile('B.md'));
	assert.deepEqual(visible.list, []);

	await synchronizeAllOnClock(t, manager);
	assert.deepEqual(visible.list, []);
});

clockTest('a nesting cycle reports under its block ID until a clean pass clears it', async (t) => {
	const N1 = '<!--#a+-->\n<!--#b=-->\nq\n<!--#b/-->\n<!--#a/-->\n';
	const N2 = '<!--#b+-->\nq\n<!--#a=-->\nq\n<!--#a/-->\n<!--#b/-->\n';
	const FIXED_N2 = '<!--#b+-->\nq\n<!--#b/-->\n';
	const ownerOne = {};
	const ownerTwo = {};
	const { manager, vault, issues, clears, visible } = createManager({
		vault: createVault({ 'N1.md': N1, 'N2.md': N2 }),
	});
	manager.observe(ownerOne, 'N1.md', N1);
	manager.observe(ownerTwo, 'N2.md', N2);
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(issues, [{ 'N1.md': [], 'N2.md': [], 'block:a': [CYCLE_A_ERROR] }]);
	assert.deepEqual(visible.list, [CYCLE_A_ERROR]);

	// N2 drops its reference to a, which breaks the cycle; the next pass covers both IDs.
	vault.write('N2.md', FIXED_N2);
	manager.observe(ownerTwo, 'N2.md', FIXED_N2, undefined, true);
	await runUntil(t, () => clears.length === 1);
	assert.deepEqual(sortedKeys(clears), [['', 'N1.md', 'N2.md', 'block:a', 'block:b']]);
	assert.deepEqual(visible.list, []);
});

clockTest('a failed pass does not report an ID that left the index meanwhile', async (t) => {
	const owner = {};
	const N = '<!--#n=-->\nq\n<!--#n/-->\n';
	const { manager, vault, saveCalls, completeSave, issues, visible } = createManager({
		holdSaves: true,
		vault: createVault({ 'A.md': N }),
	});
	manager.observe(owner, 'A.md', N);
	// The first index save is held, so the pass waits until it is released.
	await runUntil(t, () => saveCalls.length === 1);
	completeSave();
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(visible.list, [N_NO_SOURCE_ERROR]);

	// Appending a line changes the saved index, so the failed pass's report waits on a save.
	const edited = `${N}plain\n`;
	vault.write('A.md', edited);
	manager.observe(owner, 'A.md', edited);
	await runUntil(t, () => saveCalls.length === 2);

	// The owner closes and the note is deleted while that report waits.
	manager.unobserve(owner);
	vault.remove('A.md');
	manager.markDeleted(eventFile('A.md'));
	assert.deepEqual(visible.list, []);

	completeSave();
	await runUntil(t, () => issues.length === 2);
	assert.deepEqual(visible.list, []);
});
