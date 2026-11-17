import { Plugin, TFile } from 'obsidian';
import {
	applyPatches,
	Block,
	FileText,
	normalize,
	parseFile,
	Patch,
	planSync,
	referenceChangeKey,
	sourceChangeKey,
} from './blocks';
import { nestedSyncOrder, rebaseContainingFingerprints } from './nesting';
import { blockIssueKey, INTERRUPTED_ISSUE_KEY } from './sync-issues';
import {
	createStoredSyncData,
	LegacyStoredSyncData,
	loadSyncState,
} from './sync-state';

export type { LegacyStoredSyncData } from './sync-state';

const INDEX_CHUNK_SIZE = 50;
const SYNC_DELAY = 100;
const MARKER_ID = /<!--#\/?([^\s>]+?)(?=[+=/]|-->|\s)/g;

export interface LiveDocument {
	read(): string;
	apply(patches: Patch[]): boolean;
}

interface Observation {
	path: string;
	ids: Set<string>;
	text: string;
	document?: LiveDocument;
	revision: number;
}

interface IndexedFile {
	mtime: number;
	size: number;
	ids: Set<string>;
	sourceIds: Set<string>;
}

/** Issue keys are note paths, `blockIssueKey(id)`, or `INTERRUPTED_ISSUE_KEY` (see sync-issues). */
export interface SyncManagerCallbacks {
	/** Issues for every key a pass checked; an empty list means that key is clear. */
	onIssues(issues: Map<string, string[]>): void;
	onClearIssues(keys: string[]): void;
	onRenameIssues(from: string, to: string): void;
	onFilesChanged(files: FileText[]): void;
}

class ConcurrentEditError extends Error {}

/**
 * Keeps a disk-backed structural index and validates it only when a displayed
 * block (or an explicit command) needs synchronization. Block bodies remain in
 * Markdown; plugin data contains fingerprints and file metadata only.
 */
export class BlockSyncManager {
	private hashes: Record<string, string> = {};
	private knownRefs: Record<string, boolean> = {};
	private savedSourcePaths: Record<string, string> = {};
	private observations = new Map<object, Observation>();
	private activeIds = new Set<string>();
	private files = new Map<string, IndexedFile>();
	private pathsById = new Map<string, Set<string>>();
	private sourcePathsById = new Map<string, Set<string>>();
	private dirtyPaths = new Set<string>();
	private queuedIds = new Set<string>();
	private localChanges = new Set<string>();
	private indexReady = false;
	private indexValidated = false;
	private indexPromise: Promise<void> | null = null;
	private syncTimer: number | null = null;
	private dirtyTimer: number | null = null;
	private lastSaved = '';
	private saveQueue: Promise<void> = Promise.resolve();
	private running = false;
	private passDone: Promise<void> = Promise.resolve();
	private rerun = false;
	private observationRevision = 0;

	constructor(
		private plugin: Plugin,
		private callbacks: SyncManagerCallbacks,
	) {}

	load(raw: LegacyStoredSyncData | null): void {
		const stored = loadSyncState(raw);
		this.hashes = stored.hashes;
		this.knownRefs = stored.knownRefs;
		this.savedSourcePaths = stored.sourcePaths;

		if (!stored.files) return;
		for (const [path, entry] of Object.entries(stored.files))
			if (entry.ids.length)
				this.addIndexedPath(path, {
					mtime: entry.mtime,
					size: entry.size,
					ids: new Set(entry.ids),
					sourceIds: new Set(entry.sourceIds),
				});
		this.indexReady = true;
		// Stat indexed block notes when a shared block is first displayed. This
		// finds outside changes without retaining or reading every vault note.
		this.indexValidated = false;
	}

	unload(): void {
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		if (this.dirtyTimer !== null) window.clearTimeout(this.dirtyTimer);
		this.syncTimer = null;
		this.dirtyTimer = null;
		this.observations.clear();
		this.activeIds.clear();
	}

	observe(
		owner: object,
		path: string,
		text: string,
		document?: LiveDocument,
		editedInObsidian = false,
	): void {
		const parsed = parseFile(path, text);
		const ids = markerIds(text, parsed.blocks);
		const previous = this.observations.get(owner);
		if (!ids.size && !parsed.errors.length) {
			this.unobserve(owner, path);
			return;
		}
		if (editedInObsidian && previous?.path === path)
			for (const key of changedBlockKeys(path, previous.text, text))
				this.localChanges.add(key);
		this.observations.set(owner, {
			path,
			ids,
			text,
			document,
			revision: ++this.observationRevision,
		});
		this.indexParsed(path, text, parsed.blocks);
		this.rebuildActiveIds();
		const requested = new Set([...ids, ...(previous?.ids ?? [])]);
		if (requested.size) this.queue(requested, previous ? SYNC_DELAY : 0);
	}

	/** Pass `markersRemovedFrom` when the owner's note lost its last marker, to clear its issues. */
	unobserve(owner: object, markersRemovedFrom?: string): void {
		const observation = this.observations.get(owner);
		if (!observation) return;
		this.observations.delete(owner);
		if (observation.path === markersRemovedFrom) this.setIndexedPath(markersRemovedFrom);
		this.rebuildActiveIds();
		for (const id of this.queuedIds)
			if (!this.activeIds.has(id)) this.queuedIds.delete(id);
		if (!this.queuedIds.size && this.syncTimer !== null) {
			window.clearTimeout(this.syncTimer);
			this.syncTimer = null;
		}
	}

	markModified(file: TFile): void {
		// A legacy cache has no structural index yet; its eventual first scan will
		// include this change. Once an index exists, events let an unindexed note
		// gain its first block without retaining every empty note in plugin data.
		if (!this.indexReady && !this.indexPromise) return;
		this.dirtyPaths.add(file.path);
		this.indexValidated = false;
		if (this.activeIds.size) this.scheduleDirtyPaths();
	}

	markDeleted(file: TFile): void {
		const previous = this.files.get(file.path)?.ids ?? new Set<string>();
		this.setIndexedPath(file.path);
		this.dirtyPaths.delete(file.path);
		this.indexValidated = false;
		const affected = intersection(previous, this.activeIds);
		if (affected.size) this.queue(affected, 0);
	}

	markRenamed(file: TFile, oldPath: string): void {
		const previous = this.files.get(oldPath)?.ids ?? new Set<string>();
		// The note's markers move with it, so its issues follow instead of clearing.
		this.callbacks.onRenameIssues(oldPath, file.path);
		this.removeIndexedPath(oldPath);
		this.dirtyPaths.delete(oldPath);
		this.dirtyPaths.add(file.path);
		this.indexValidated = false;
		for (const [id, path] of Object.entries(this.savedSourcePaths))
			if (path === oldPath) this.savedSourcePaths[id] = file.path;
		if (this.activeIds.size) this.scheduleDirtyPaths();
		const affected = intersection(previous, this.activeIds);
		if (affected.size) this.queue(affected, SYNC_DELAY);
	}

	/** Runs a full pass now, after any pass already running, rather than deferring it. */
	async synchronizeAll(): Promise<void> {
		await this.ensureIndex(true);
		while (this.running) await this.passDone;
		await this.synchronize(new Set(this.pathsById.keys()));
	}

	async getSources(): Promise<Block[]> {
		await this.ensureIndex();
		const sources: Block[] = [];
		for (const [id, paths] of this.sourcePathsById)
			for (const path of paths) {
				const located = await this.readSource(path, id);
				if (located) sources.push(located.block);
			}
		return sources.sort((a, b) => a.id.localeCompare(b.id));
	}

	async findSource(
		id: string,
	): Promise<{ block: Block; file: TFile } | null> {
		await this.ensureIndex();
		const paths = this.sourcePathsById.get(id);
		if (!paths || paths.size !== 1) return null;
		const located = await this.readSource([...paths][0]!, id);
		if (!located) {
			delete this.savedSourcePaths[id];
			return null;
		}
		return located;
	}

	async filesForId(id: string): Promise<FileText[]> {
		await this.ensureIndex();
		return this.readFiles(this.pathsById.get(id) ?? new Set());
	}

	async readCurrentText(path: string): Promise<string | null> {
		const live = this.liveDocument(path);
		if (live) return live.read();
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? this.plugin.app.vault.read(file) : null;
	}

	async replaceFileText(
		path: string,
		expected: string,
		replacement: string,
	): Promise<void> {
		const patch: Patch = {
			path,
			from: 0,
			to: expected.length,
			oldBody: expected,
			body: replacement,
		};
		await this.applyFilePatches(path, [patch], [{ path, text: expected }]);
		await this.persist();
		this.callbacks.onFilesChanged([{ path, text: replacement }]);
	}

	async forget(id: string): Promise<void> {
		delete this.hashes[id];
		delete this.savedSourcePaths[id];
		this.knownRefs = Object.fromEntries(
			Object.entries(this.knownRefs).filter(
				([key]) => key.split('\u0000')[1] !== id,
			),
		);
		this.clearLocalChanges(new Set([id]));
		await this.persist();
	}

	private rebuildActiveIds(): void {
		this.activeIds = new Set(
			[...this.observations.values()].flatMap((observation) => [
				...observation.ids,
			]),
		);
	}

	private queue(ids: Iterable<string>, delay: number): void {
		for (const id of ids) this.queuedIds.add(id);
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			void this.drainQueue();
		}, delay);
	}

	private async drainQueue(): Promise<void> {
		if (this.running) {
			this.rerun = true;
			return;
		}
		const ids = new Set(this.queuedIds);
		this.queuedIds.clear();
		if (!ids.size) return;
		await this.ensureIndex();
		await this.synchronize(ids);
	}

	private async synchronize(ids: Set<string>): Promise<void> {
		if (this.running) {
			for (const id of ids) this.queuedIds.add(id);
			this.rerun = true;
			return;
		}
		this.running = true;
		let finishPass!: () => void;
		this.passDone = new Promise((resolve) => (finishPass = resolve));
		try {
			const scope = await this.expandNestedScope(ids);
			ids = scope.ids;
			const paths = scope.files.map((file) => file.path);
			// Every note in scope is parsed, so its parse errors clear by path. Block errors
			// clear only for the blocks this pass reached, keyed by block ID.
			const issues = issuesByPath(paths, scope.errors);
			const reportIssues = async (): Promise<void> => {
				await this.persist();
				this.callbacks.onIssues(issues);
			};
			if (scope.errors.length) {
				await reportIssues();
				return;
			}
			// Always re-read all known copies for the requested IDs. The index only
			// locates files; hashes decide whether an outside edit is safe to apply.
			let scanned = scope.files;
			const order = nestedSyncOrder(scanned, ids);
			if (order.errors.length) {
				// Each nesting error starts with the ID of the cycle it found.
				for (const error of order.errors) {
					const key = blockIssueKey(error.slice(0, error.indexOf(':')));
					issues.set(key, [...(issues.get(key) ?? []), error]);
				}
				await reportIssues();
				return;
			}
			let nextHashes = this.hashes;
			let nextRefs = this.knownRefs;
			const stages: Array<{
				files: FileText[];
				patchesByPath: Map<string, Patch[]>;
			}> = [];
			for (const id of order.ids) {
				const plan = planSync(
					scanned,
					nextHashes,
					nextRefs,
					new Set([id]),
					this.localChanges,
				);
				issues.set(blockIssueKey(id), plan.errors);
				if (plan.errors.length) {
					await reportIssues();
					return;
				}
				const patchesByPath = groupPatchesByPath(plan.patches);
				if (patchesByPath.size)
					stages.push({ files: scanned, patchesByPath });
				const updated = scanned.map((file) => {
					const patches = patchesByPath.get(file.path);
					return patches
						? { ...file, text: applyPatches(file.text, patches) }
						: file;
				});
				nextHashes = plan.next;
				rebaseContainingFingerprints(
					scanned,
					updated,
					patchesByPath,
					nextHashes,
				);
				nextRefs = plan.nextRefs;
				scanned = updated;
			}
			this.callbacks.onClearIssues([
				...paths,
				...[...ids].map(blockIssueKey),
				INTERRUPTED_ISSUE_KEY,
			]);
			for (const stage of stages)
				for (const [path, patches] of stage.patchesByPath)
					await this.applyFilePatches(path, patches, stage.files);
			this.hashes = nextHashes;
			this.knownRefs = nextRefs;
			this.clearLocalChanges(ids);
			this.refreshSavedSourcePaths(ids);
			const changedPaths = new Set(
				stages.flatMap((stage) => [...stage.patchesByPath.keys()]),
			);
			this.callbacks.onFilesChanged(
				scanned.filter((file) => changedPaths.has(file.path)),
			);
			await this.persist();
		} catch (error) {
			if (error instanceof ConcurrentEditError) {
				// The vault changed between the read and guarded write. Rebuild the
				// plan from the new contents instead of surfacing a transient error
				// and leaving the copies permanently unsynchronized.
				for (const id of ids) this.queuedIds.add(id);
				this.rerun = true;
				return;
			}
			console.error(
				'Full Block Embed: synchronization interrupted',
				error,
			);
			// The scope may not exist yet, so the issue waits for any clean pass to clear it.
			this.callbacks.onIssues(
				new Map([
					[INTERRUPTED_ISSUE_KEY, [`Synchronization interrupted: ${String(error)}`]],
				]),
			);
		} finally {
			this.running = false;
			finishPass();
			if (this.rerun || this.queuedIds.size) {
				this.rerun = false;
				this.queue([], SYNC_DELAY);
			}
		}
	}

	private async expandNestedScope(
		requested: ReadonlySet<string>,
	): Promise<{ ids: Set<string>; files: FileText[]; errors: string[] }> {
		const ids = new Set(requested);
		const paths = new Set<string>();
		let changed = true;
		let files: FileText[] = [];
		let errors: string[] = [];
		while (changed) {
			changed = false;
			for (const id of ids)
				for (const path of this.pathsById.get(id) ?? [])
					if (!paths.has(path)) {
						paths.add(path);
						changed = true;
					}
			files = await this.readFiles(paths);
			errors = [];
			for (const file of files) {
				const { blocks, errors: fileErrors } = parseFile(file.path, file.text);
				errors.push(...fileErrors);
				for (const parent of blocks) {
					if (!ids.has(parent.id)) continue;
					for (const child of blocks)
						if (
							child.start > parent.start &&
							child.end < parent.end &&
							!ids.has(child.id)
						) {
							ids.add(child.id);
							changed = true;
						}
				}
			}
		}
		return { ids, files, errors };
	}

	private async applyFilePatches(
		path: string,
		patches: Patch[],
		scanned: FileText[],
	): Promise<void> {
		const expected = scanned.find((file) => file.path === path)?.text;
		if (expected === undefined)
			throw new Error(`Scanned note disappeared: ${path}`);
		const updated = applyPatches(expected, patches);
		const live = this.liveDocuments(path);
		if (live.length) {
			// A file can be represented by more than one open editor (for example,
			// a normal source note and an embedded reference editor). Validate all
			// buffers before changing any of them, then keep every matching buffer
			// together so an older view cannot later overwrite the synchronized one.
			const texts = live.map((document) => document.read());
			if (texts.some((text) => text !== expected && text !== updated))
				throw new ConcurrentEditError(`Concurrent edit in ${path}`);
			if (
				!live.every(
					(document) => {
						const current = document.read();
						return (
							current === updated ||
							(current === expected && document.apply(patches))
						);
					},
				)
			)
				throw new ConcurrentEditError(`Concurrent edit in ${path}`);
			this.indexText(path, updated);
			return;
		}
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile))
			throw new Error(`Note disappeared: ${path}`);
		let written = expected;
		await this.plugin.app.vault.process(file, (current) => {
			if (current !== expected)
				throw new ConcurrentEditError(`Concurrent edit in ${path}`);
			written = applyPatches(current, patches);
			return written;
		});
		this.indexText(path, written, file.stat.mtime, file.stat.size);
	}

	private liveDocument(path: string): LiveDocument | undefined {
		return this.liveDocuments(path)[0];
	}

	private liveDocuments(path: string): LiveDocument[] {
		return [...this.observations.values()]
			.filter(
				(
					observation,
				): observation is Observation & { document: LiveDocument } =>
					observation.path === path &&
					observation.document !== undefined,
			)
			.sort((a, b) => b.revision - a.revision)
			.map((observation) => observation.document);
	}

	private async readFiles(paths: Iterable<string>): Promise<FileText[]> {
		const result: FileText[] = [];
		for (const path of paths) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			const live = this.liveDocument(path);
			result.push({
				path,
				text: live?.read() ?? (await this.plugin.app.vault.read(file)),
			});
		}
		return result;
	}

	private async readSource(
		path: string,
		id: string,
	): Promise<{ block: Block; file: TFile } | null> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		const text =
			this.liveDocument(path)?.read() ??
			(await this.plugin.app.vault.read(file));
		const block = parseFile(path, text).blocks.find(
			(candidate) => candidate.id === id && candidate.kind === '+',
		);
		return block ? { block, file } : null;
	}

	private scheduleDirtyPaths(): void {
		if (this.dirtyTimer !== null) window.clearTimeout(this.dirtyTimer);
		this.dirtyTimer = window.setTimeout(() => {
			this.dirtyTimer = null;
			void this.drainDirtyPaths();
		}, SYNC_DELAY);
	}

	private async drainDirtyPaths(): Promise<void> {
		const paths = [...this.dirtyPaths];
		for (const path of paths) this.dirtyPaths.delete(path);
		const affected = new Set<string>();
		for (const path of paths) {
			const before = this.files.get(path)?.ids ?? new Set<string>();
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await this.scanFile(file);
			else this.setIndexedPath(path);
			const after = this.files.get(path)?.ids ?? new Set<string>();
			for (const id of [...before, ...after])
				if (this.activeIds.has(id)) affected.add(id);
		}
		this.indexValidated = this.dirtyPaths.size === 0;
		this.refreshAllSavedSourcePaths();
		await this.persist();
		if (affected.size) this.queue(affected, 0);
		else if (this.dirtyPaths.size) this.scheduleDirtyPaths();
	}

	private async ensureIndex(force = false): Promise<void> {
		if (this.indexPromise) return this.indexPromise;
		if (this.indexReady && this.indexValidated && !force) return;
		this.indexPromise = this.prepareIndex(force);
		try {
			await this.indexPromise;
			await this.persist();
		} finally {
			this.indexPromise = null;
		}
	}

	private async prepareIndex(force: boolean): Promise<void> {
		if (force || !this.indexReady) await this.scanVault();
		else await this.refreshChangedFiles();
		while (!this.indexValidated) await this.refreshChangedFiles();
	}

	private async scanVault(): Promise<void> {
		const previousPaths = [...this.files.keys()];
		const previousIds = [...this.pathsById.keys()];
		this.files.clear();
		this.pathsById.clear();
		this.sourcePathsById.clear();
		this.dirtyPaths.clear();
		const files = this.plugin.app.vault.getMarkdownFiles();
		for (let i = 0; i < files.length; i += INDEX_CHUNK_SIZE) {
			for (const file of files.slice(i, i + INDEX_CHUNK_SIZE))
				await this.scanFile(file);
			await yieldToUi();
		}
		this.clearIssuesLeftIndex(previousPaths, previousIds);
		this.indexReady = true;
		this.indexValidated = this.dirtyPaths.size === 0;
		this.refreshAllSavedSourcePaths();
	}

	private async refreshChangedFiles(): Promise<void> {
		const dirty = new Set(this.dirtyPaths);
		for (const path of dirty) this.dirtyPaths.delete(path);
		const candidates = new Map<string, TFile>();
		for (const path of new Set([...this.files.keys(), ...dirty])) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === 'md')
				candidates.set(path, file);
			else this.setIndexedPath(path);
		}
		const changed = [...candidates.values()].filter((file) => {
			const indexed = this.files.get(file.path);
			return (
				dirty.has(file.path) ||
				(indexed !== undefined &&
					(indexed.mtime !== file.stat.mtime ||
						indexed.size !== file.stat.size))
			);
		});
		for (let i = 0; i < changed.length; i += INDEX_CHUNK_SIZE) {
			for (const file of changed.slice(i, i + INDEX_CHUNK_SIZE))
				await this.scanFile(file);
			await yieldToUi();
		}
		this.indexReady = true;
		this.indexValidated = this.dirtyPaths.size === 0;
		this.refreshAllSavedSourcePaths();
	}

	private async scanFile(file: TFile): Promise<void> {
		try {
			const live = this.liveDocument(file.path);
			const text = live?.read() ?? (await this.plugin.app.vault.read(file));
			this.indexText(file.path, text, file.stat.mtime, file.stat.size);
		} catch (error) {
			console.error(
				`Full Block Embed: unable to scan ${file.path}`,
				error,
			);
		}
	}

	private indexText(
		path: string,
		text: string,
		mtime?: number,
		size?: number,
	): void {
		this.indexParsed(path, text, parseFile(path, text).blocks, mtime, size);
	}

	private indexParsed(
		path: string,
		text: string,
		blocks: Block[],
		mtime?: number,
		size?: number,
	): void {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		const stat = file instanceof TFile ? file.stat : undefined;
		const ids = markerIds(text, blocks);
		const sourceIds = new Set(
			blocks
				.filter((block) => block.kind === '+')
				.map((block) => block.id),
		);
		this.setIndexedPath(path, {
			mtime: mtime ?? stat?.mtime ?? 0,
			size: size ?? stat?.size ?? text.length,
			ids,
			sourceIds,
		});
	}

	/** Replaces a path's index entry; with no IDs to index, the path leaves the index. */
	private setIndexedPath(path: string, indexed?: IndexedFile): void {
		const previousIds = [...(this.files.get(path)?.ids ?? [])];
		const wasIndexed = this.files.has(path);
		this.removeIndexedPath(path);
		if (indexed?.ids.size) this.addIndexedPath(path, indexed);
		if (wasIndexed) this.clearIssuesLeftIndex([path], previousIds);
	}

	// No later pass covers a path or block that left the index, so its issues would never clear.
	private clearIssuesLeftIndex(paths: string[], ids: string[]): void {
		const gone = [
			...paths.filter((path) => !this.files.has(path)),
			...ids.filter((id) => !this.pathsById.has(id)).map(blockIssueKey),
		];
		if (gone.length) this.callbacks.onClearIssues(gone);
	}

	private addIndexedPath(path: string, indexed: IndexedFile): void {
		this.files.set(path, indexed);
		for (const id of indexed.ids) addPath(this.pathsById, id, path);
		for (const id of indexed.sourceIds)
			addPath(this.sourcePathsById, id, path);
	}

	private removeIndexedPath(path: string): void {
		const previous = this.files.get(path);
		if (!previous) return;
		for (const id of previous.ids) removePath(this.pathsById, id, path);
		for (const id of previous.sourceIds)
			removePath(this.sourcePathsById, id, path);
		this.files.delete(path);
	}

	private refreshSavedSourcePaths(ids: Iterable<string>): void {
		for (const id of ids) {
			const paths = this.sourcePathsById.get(id);
			if (paths?.size === 1) this.savedSourcePaths[id] = [...paths][0]!;
			else delete this.savedSourcePaths[id];
		}
	}

	private refreshAllSavedSourcePaths(): void {
		this.refreshSavedSourcePaths(
			new Set([
				...this.sourcePathsById.keys(),
				...Object.keys(this.savedSourcePaths),
			]),
		);
	}

	private clearLocalChanges(ids: ReadonlySet<string>): void {
		for (const key of this.localChanges)
			if (ids.has(key.split('\u0000')[1] ?? ''))
				this.localChanges.delete(key);
	}

	// One save runs at a time, so lastSaved always matches the newest save requested.
	private persist(): Promise<void> {
		const run = this.saveQueue.then(() => this.save());
		this.saveQueue = run.catch(() => undefined);
		return run;
	}

	private async save(): Promise<void> {
		const data = createStoredSyncData(
			this.hashes,
			this.knownRefs,
			this.savedSourcePaths,
			this.files,
		);
		const serialized = JSON.stringify(data);
		if (serialized === this.lastSaved) return;
		await this.plugin.saveData(data);
		this.lastSaved = serialized;
	}
}

/**
 * Files each parse error under the note it names (`path:line: …`), giving every other note
 * in the pass an empty list. An error naming no note in the pass waits for a clean pass.
 */
export function issuesByPath(paths: string[], errors: string[]): Map<string, string[]> {
	const result = new Map(paths.map((path) => [path, [] as string[]]));
	for (const error of errors) {
		const owner =
			paths.find((path) => error.startsWith(`${path}:`)) ?? INTERRUPTED_ISSUE_KEY;
		result.set(owner, [...(result.get(owner) ?? []), error]);
	}
	return result;
}

function groupPatchesByPath(patches: Patch[]): Map<string, Patch[]> {
	const result = new Map<string, Patch[]>();
	for (const patch of patches)
		result.set(patch.path, [...(result.get(patch.path) ?? []), patch]);
	return result;
}

function addPath(
	index: Map<string, Set<string>>,
	id: string,
	path: string,
): void {
	const paths = index.get(id) ?? new Set<string>();
	paths.add(path);
	index.set(id, paths);
}

function removePath(
	index: Map<string, Set<string>>,
	id: string,
	path: string,
): void {
	const paths = index.get(id);
	if (!paths) return;
	paths.delete(path);
	if (!paths.size) index.delete(id);
}

function intersection(
	a: ReadonlySet<string>,
	b: ReadonlySet<string>,
): Set<string> {
	return new Set([...a].filter((value) => b.has(value)));
}

function markerIds(text: string, blocks: Block[]): Set<string> {
	const ids = new Set(blocks.map((block) => block.id));
	for (const match of text.matchAll(MARKER_ID))
		if (match[1]) ids.add(match[1]);
	return ids;
}

function changedBlockKeys(
	path: string,
	previousText: string,
	currentText: string,
): Set<string> {
	const previous = blockBodiesByKey(path, previousText);
	const current = blockBodiesByKey(path, currentText);
	return new Set(
		[...current].flatMap(([key, body]) =>
			previous.get(key) === body ? [] : [key],
		),
	);
}

function blockBodiesByKey(path: string, text: string): Map<string, string> {
	const result = new Map<string, string>();
	const ordinals = new Map<string, number>();
	for (const block of parseFile(path, text).blocks) {
		if (block.kind === '+') {
			result.set(sourceChangeKey(path, block.id), normalize(block.body));
			continue;
		}
		const ordinal = ordinals.get(block.id) ?? 0;
		ordinals.set(block.id, ordinal + 1);
		result.set(
			referenceChangeKey(path, block.id, ordinal),
			normalize(block.body),
		);
	}
	return result;
}

function yieldToUi(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}
