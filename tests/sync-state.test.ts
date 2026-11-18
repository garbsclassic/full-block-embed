import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { contentFingerprint } from '../src/blocks.ts';
import type * as SyncStateModule from '../src/sync-state.ts';

const { createStoredSyncData, loadSyncState } = await createJiti(
	import.meta.url,
).import<typeof SyncStateModule>('../src/sync-state.ts');

test('disk cache includes structural metadata and synchronization hashes', () => {
	const privateBody = 'Body content belongs only in the Markdown note';
	const hash = contentFingerprint(privateBody);
	const stored = createStoredSyncData(
		{ example: hash },
		{ 'Reference.md\u0000example\u00000': true },
		new Map([
			[
				'Source.md',
				{
					mtime: 123,
					size: 456,
					ids: new Set(['example']),
					sourceIds: new Set(['example']),
				},
			],
			[
				'Ordinary.md',
				{
					mtime: 789,
					size: 12,
					ids: new Set<string>(),
					sourceIds: new Set<string>(),
				},
			],
		]),
		1234,
	);

	assert.equal(stored.version, 3);
	assert.equal(stored.hashes.example, hash);
	assert.deepEqual(stored.files['Source.md'], {
		mtime: 123,
		size: 456,
		ids: ['example'],
		sourceIds: ['example'],
	});
	assert.equal(stored.files['Ordinary.md'], undefined);
	assert.ok(!JSON.stringify(stored).includes(privateBody));
	assert.deepEqual(loadSyncState(stored), {
		hashes: { example: hash },
		knownRefs: { 'Reference.md\u0000example\u00000': true },
		files: stored.files,
		savedAt: 1234,
	});
});

test('loading drops baselines that are not fingerprints and indexes without a version', () => {
	const hash = contentFingerprint('Kept');
	const loaded = loadSyncState({
		hashes: { kept: hash, raw: 'Private body', wrong: 42 as unknown as string },
		files: {},
	});
	assert.deepEqual(loaded.hashes, { kept: hash });
	assert.equal(loaded.files, undefined);
});

test('loading defaults the save time to 0 when it is missing or not a finite number', () => {
	const stored = { version: 3 as const, hashes: {}, knownRefs: {}, files: {} };

	assert.equal(loadSyncState(stored).savedAt, 0);
	assert.equal(loadSyncState({ ...stored, savedAt: Number.NaN }).savedAt, 0);
	assert.equal(loadSyncState({ ...stored, savedAt: Infinity }).savedAt, 0);
	assert.equal(loadSyncState({ ...stored, savedAt: '5' as unknown as number }).savedAt, 0);
	assert.equal(loadSyncState({ ...stored, savedAt: 42 }).savedAt, 42);
});

test('loading keeps only known references whose value is exactly true', () => {
	const loaded = loadSyncState({
		knownRefs: {
			kept: true,
			text: 'false' as unknown as boolean,
			number: 1 as unknown as boolean,
			off: false,
		},
	});

	assert.deepEqual(loaded.knownRefs, { kept: true });
});
