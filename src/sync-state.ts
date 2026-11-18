export interface StoredFileIndex {
	mtime: number;
	size: number;
	ids: string[];
	sourceIds: string[];
}

export interface StoredSyncData {
	version: 3;
	hashes: Record<string, string>;
	knownRefs: Record<string, boolean>;
	files: Record<string, StoredFileIndex>;
	/** Milliseconds since the epoch; notes changed after it may be missing from `files`. */
	savedAt: number;
}

export interface IndexedFileMetadata {
	mtime: number;
	size: number;
	ids: ReadonlySet<string>;
	sourceIds: ReadonlySet<string>;
}

export interface LoadedSyncState {
	hashes: Record<string, string>;
	knownRefs: Record<string, boolean>;
	files?: Record<string, StoredFileIndex>;
	savedAt: number;
}

const FINGERPRINT = /^v1:\d+:[0-9a-f]{32}$/;

/** Plugin data can be edited by hand, so every value is checked before use. */
export function loadSyncState(raw: Partial<StoredSyncData> | null): LoadedSyncState {
	const stored = raw ?? {};
	const hashes = Object.fromEntries(
		Object.entries(stored.hashes ?? {}).filter(
			([, value]) => typeof value === 'string' && FINGERPRINT.test(value),
		),
	);
	const files =
		stored.version === 3 && stored.files
			? Object.fromEntries(
					Object.entries(stored.files).filter(
						([, entry]) => validStoredFile(entry) && entry.ids.length > 0,
					),
				)
			: undefined;
	// Without a save time, every note counts as possibly changed since the last save.
	const savedAt = Number.isFinite(stored.savedAt) ? stored.savedAt! : 0;
	return { hashes, knownRefs: { ...(stored.knownRefs ?? {}) }, files, savedAt };
}

export function createStoredSyncData(
	hashes: Record<string, string>,
	knownRefs: Record<string, boolean>,
	indexedFiles: ReadonlyMap<string, IndexedFileMetadata>,
	savedAt: number,
): StoredSyncData {
	const files: Record<string, StoredFileIndex> = {};
	for (const [path, indexed] of indexedFiles) {
		if (!indexed.ids.size) continue;
		files[path] = {
			mtime: indexed.mtime,
			size: indexed.size,
			ids: [...indexed.ids].sort(),
			sourceIds: [...indexed.sourceIds].sort(),
		};
	}
	return { version: 3, hashes, knownRefs, files, savedAt };
}

function validStoredFile(value: StoredFileIndex): boolean {
	return (
		value !== null &&
		typeof value === 'object' &&
		Number.isFinite(value.mtime) &&
		Number.isFinite(value.size) &&
		Array.isArray(value.ids) &&
		value.ids.every((id) => typeof id === 'string') &&
		Array.isArray(value.sourceIds) &&
		value.sourceIds.every((id) => typeof id === 'string')
	);
}
