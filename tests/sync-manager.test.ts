import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { createJiti } from 'jiti';
import type { Plugin } from 'obsidian';
import type * as ObsidianStub from './stubs/obsidian.ts';
import type * as SyncManagerModule from '../src/sync-manager.ts';

const obsidianStub = fileURLToPath(new URL('./stubs/obsidian.ts', import.meta.url));
// One loader for both modules: the manager's `obsidian` import must resolve to the same TFile
// class the fake vault instantiates, or the manager's `instanceof TFile` checks reject every note.
const loader = createJiti(import.meta.url, { alias: { obsidian: obsidianStub } });
const { TFile } = await loader.import<typeof ObsidianStub>(obsidianStub);
const { BlockSyncManager, issuesByPath } = await loader.import<typeof SyncManagerModule>(
	'../src/sync-manager.ts',
);
type VaultFile = ObsidianStub.TFile & { path: string };

const FINGERPRINT = 'v1:12:0123456789abcdef0123456789abcdef';
const OTHER_FINGERPRINT = 'v1:13:fedcba9876543210fedcba9876543210';

const BROKEN_A = 'intro\n<!--#foo+-->\nbody\n';
const PLAIN_A = 'intro\nbody\n';
const BROKEN_B = '<!--#bar+-->\nb\n';
const FIXED_B = '<!--#bar+-->\nb\n<!--#bar/-->\n';
const CLEAN_C = '<!--#baz+-->\nc\n<!--#baz/-->\n<!--#baz=-->\nc\n<!--#baz/-->\n';
const A_FOO_ERROR = 'A.md:2: unclosed source block foo (closing marker is missing)';
const B_BAR_ERROR = 'B.md:1: unclosed source block bar (closing marker is missing)';

function storedWith(hashes: Record<string, string>) {
	return { version: 3, hashes, knownRefs: {}, sourcePaths: {}, files: {} };
}

// setImmediate runs after every pending microtask, so queued work reaches its next await.
function flushEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

// In-memory vault covering the calls a synchronization pass makes: lookup, listing, read, process.
function createVault(notes: Record<string, string>) {
	const texts = new Map(Object.entries(notes));
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
			const next = update(texts.get(file.path) ?? '');
			texts.set(file.path, next);
			return next;
		},
		// Stands in for saving an edit, so later passes read the new text from the vault.
		write: (path: string, text: string) => {
			texts.set(path, text);
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
	const plugin = {
		app: { vault },
		saveData: async (data: unknown) => {
			// Snapshot the payload as Obsidian would persist it, since the manager keeps
			// mutating the maps it passed in.
			saveCalls.push(structuredClone(data));
			if (holdSaves)
				await new Promise<void>((complete) => heldSaves.push(complete));
			const failure = failures.shift();
			if (failure) throw failure;
		},
	} as unknown as Plugin;
	const manager = new BlockSyncManager(plugin, {
		onIssues: (reported) => {
			issues.push(Object.fromEntries(reported));
		},
		onClearIssues: (paths) => {
			clears.push(paths);
		},
		onFilesChanged: () => undefined,
	});
	return {
		manager,
		vault,
		saveCalls,
		issues,
		clears,
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
	const { manager, issues, clears } = createManager({
		vault: createVault({ 'A.md': BROKEN_A }),
	});
	manager.observe(editor, 'A.md', BROKEN_A);
	await runUntil(t, () => issues.length === 1);
	assert.deepEqual(issues, [{ 'A.md': [A_FOO_ERROR] }]);

	// The editor unobserves with the note path once its document no longer contains a marker.
	manager.unobserve(editor, 'A.md');

	assert.deepEqual(clears, [['A.md']]);
});

clockTest('observing a note without markers clears its earlier issue', async (t) => {
	const editor = {};
	const { manager, issues, clears } = createManager({
		vault: createVault({ 'A.md': BROKEN_A }),
	});
	manager.observe(editor, 'A.md', BROKEN_A);
	await runUntil(t, () => issues.length === 1);

	manager.observe(editor, 'A.md', PLAIN_A);

	assert.deepEqual(clears, [['A.md']]);
});

clockTest("a clean pass for one note does not clear another note's issue", async (t) => {
	const brokenOwner = {};
	const cleanOwner = {};
	const { manager, issues, clears } = createManager({
		vault: createVault({ 'B.md': BROKEN_B, 'C.md': CLEAN_C }),
	});
	// C is observed only after B's failure is reported, so C's pass is separate and clean.
	manager.observe(brokenOwner, 'B.md', BROKEN_B);
	await runUntil(t, () => issues.length === 1);

	manager.observe(cleanOwner, 'C.md', CLEAN_C);
	await runUntil(t, () => clears.length === 1);

	assert.deepEqual(issues, [{ 'B.md': [B_BAR_ERROR] }]);
	assert.deepEqual(clears, [['C.md']]);
});

clockTest('notes observed in the same tick each report only their own issues', async (t) => {
	const brokenOwner = {};
	const cleanOwner = {};
	const { manager, issues, clears, vault } = createManager({
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

	assert.deepEqual(clears, [['B.md']]);
	assert.deepEqual(issues, [{ 'B.md': [B_BAR_ERROR], 'C.md': [] }]);
});

clockTest('unobserving without a path clears nothing; with the path it clears', async (t) => {
	const tab = {};
	const editor = {};
	const { manager, issues, clears } = createManager({
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

	manager.unobserve(editor, 'B.md');
	assert.deepEqual(clears, [['B.md']]);
});

clockTest('a marker-free observe with no earlier observation clears nothing', async () => {
	const owner = {};
	const { manager, clears } = createManager();

	manager.observe(owner, 'Plain.md', PLAIN_A);
	assert.deepEqual(clears, []);

	// The same plain-text observe does clear once this owner has observed a marker in that note.
	manager.observe(owner, 'Plain.md', BROKEN_A);
	manager.observe(owner, 'Plain.md', PLAIN_A);
	assert.deepEqual(clears, [['Plain.md']]);
});

test('a path-prefixed error is filed under its note only', () => {
	assert.deepEqual(Object.fromEntries(issuesByPath(['A.md', 'B.md'], [A_FOO_ERROR])), {
		'A.md': [A_FOO_ERROR],
		'B.md': [],
	});
});

test('an error that names no note is filed under every note in the pass', () => {
	const conflict = 'foo: conflicting edits in A.md, B.md';

	assert.deepEqual(Object.fromEntries(issuesByPath(['A.md', 'B.md'], [conflict])), {
		'A.md': [conflict],
		'B.md': [conflict],
	});
});

test("a note and a same-named note in a subfolder do not capture each other's errors", () => {
	const subError = 'sub/a.md:1: unclosed source block x (closing marker is missing)';
	const rootError = 'a.md:3: unclosed source block y (closing marker is missing)';

	// A substring match would let 'a.md' capture 'sub/a.md:' errors in one of these orders.
	for (const paths of [
		['sub/a.md', 'a.md'],
		['a.md', 'sub/a.md'],
	]) {
		assert.deepEqual(Object.fromEntries(issuesByPath(paths, [subError, rootError])), {
			'sub/a.md': [subError],
			'a.md': [rootError],
		});
	}
});

test('a pass with no notes keeps its errors under the empty key', () => {
	assert.deepEqual(Object.fromEntries(issuesByPath([], [A_FOO_ERROR])), {
		'': [A_FOO_ERROR],
	});
});

test('an empty error list gives every note in the pass an empty list', () => {
	assert.deepEqual(Object.fromEntries(issuesByPath(['A.md', 'B.md'], [])), {
		'A.md': [],
		'B.md': [],
	});
});
