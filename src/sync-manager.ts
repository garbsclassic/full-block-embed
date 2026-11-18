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
import { createStoredSyncData, loadSyncState, StoredSyncData } from './sync-state';

export type { StoredSyncData } from './sync-state';

const INDEX_CHUNK_SIZE = 50;
const SYNC_DELAY = 500;
const MARKER_ID = /<!--#\/?([^\s>]+?)(?=[+=/]|-->|\s)/g;

export interface LiveDocument {
	read(): string;
	apply(patches: Patch[]): boolean;
}

interface Observation {
	path: string;
	ids: Set<string>;
	/** Normalized block bodies by change key, to diff against the next observation. */
	bodies: Map<string, string>;
	/** The note's parse errors, joined, to tell whether an edit changed them. */
	errors: string;
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
	/** Pending debounce; queued IDs are due once it fires. */
	private timer: number | null = null;
	/** The running work loop, which every caller waits on. */
	private working: Promise<void> | null = null;
	/** `synchronizeAll` asked for a rescan and a pass over every indexed ID. */
	private fullPass = false;
	private unsaved = true;
	/** Notes changed before this time are in the index; saved as `savedAt`. */
	private indexedThrough = 0;
	private saveQueue: Promise<void> = Promise.resolve();
	private observationRevision = 0;
	/** The loaded save time, until the first index check has looked for newer unindexed notes. */
	private changedSince: number | null = null;
	// shortcut: one failed read keeps the saved time for the rest of the session, so the next
	// launch re-reads more notes than needed; tracking failed paths would narrow it.
	private scanFailed = false;

	constructor(
		private plugin: Plugin,
		private callbacks: SyncManagerCallbacks,
	) {}

	load(raw: Partial<StoredSyncData> | null): void {
		const stored = loadSyncState(raw);
		this.hashes = stored.hashes;
		this.knownRefs = stored.knownRefs;

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
		// Stat notes when a shared block is first displayed: indexed notes whose stat changed and
		// unindexed notes newer than the last save. This finds changes made while Obsidian was
		// closed without retaining or reading every vault note.
		this.indexValidated = false;
		this.changedSince = stored.savedAt;
		this.indexedThrough = stored.savedAt;
	}

	unload(): void {
		this.cancelTimer();
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
		const bodies = blockBodiesByKey(path, parsed.blocks);
		const errors = parsed.errors.join('\n');
		let requested: Set<string>;
		if (editedInObsidian && previous?.path === path && previous.errors === errors) {
			// An in-app edit re-checks only what it touched: a changed, new, or vanished body, or a
			// marker ID that came or went. An edit that changes the parse errors re-checks every
			// block, since a stray marker outside all blocks changes neither. Outside changes to
			// other blocks arrive through vault events instead.
			const changed = changedBlockKeys(previous.bodies, bodies);
			for (const key of changed) this.localChanges.add(key);
			requested = new Set([
				...[...changed, ...changedBlockKeys(bodies, previous.bodies)].map(changeKeyId),
				...[...ids].filter((id) => !previous.ids.has(id)),
				...[...previous.ids].filter((id) => !ids.has(id)),
			]);
		} else requested = new Set([...ids, ...(previous?.ids ?? [])]);
		this.observations.set(owner, {
			path,
			ids,
			bodies,
			errors,
			document,
			revision: ++this.observationRevision,
		});
		this.indexParsed(path, text, parsed.blocks);
		this.rebuildActiveIds();
		if (requested.size) this.queue(requested, previous ? SYNC_DELAY : 0);
	}

	/**
	 * Pass `markersRemovedFrom` when the owner's note lost its last marker: the note leaves the
	 * index, which clears its issues, and its blocks still open elsewhere are re-checked.
	 */
	unobserve(owner: object, markersRemovedFrom?: string): void {
		const observation = this.observations.get(owner);
		if (!observation) return;
		this.observations.delete(owner);
		if (observation.path === markersRemovedFrom) this.setIndexedPath(markersRemovedFrom);
		this.rebuildActiveIds();
		for (const id of this.queuedIds)
			if (!this.activeIds.has(id)) this.queuedIds.delete(id);
		if (!this.activeIds.size) this.cancelTimer();
		if (observation.path !== markersRemovedFrom) return;
		// Copies shown elsewhere may have lost their source, so re-check them as an edit would.
		const affected = intersection(observation.ids, this.activeIds);
		if (affected.size) this.queue(affected, SYNC_DELAY);
	}

	markModified(file: TFile): void {
		// Without a stored index, the eventual first scan includes this change. Once an index
		// exists, events let an unindexed note gain its first block without retaining every
		// empty note in plugin data.
		if (!this.indexReady && !this.working) return;
		this.dirtyPaths.add(file.path);
		this.indexValidated = false;
		// A pending timer already brings the index up to date, and resetting it would let a stream
		// of outside edits hold back every queued pass.
		if (this.activeIds.size && this.timer === null) this.schedule(SYNC_DELAY);
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
		// The note's markers and issues move with it; the dirty mark rescans it later.
		this.callbacks.onRenameIssues(oldPath, file.path);
		const indexed = this.files.get(oldPath);
		this.removeIndexedPath(oldPath);
		if (indexed) this.addIndexedPath(file.path, indexed);
		this.dirtyPaths.delete(oldPath);
		this.dirtyPaths.add(file.path);
		this.indexValidated = false;
		if (this.activeIds.size) this.queue(intersection(previous, this.activeIds), SYNC_DELAY);
	}

	/** Runs a full pass now, after any pass already running, rather than deferring it. */
	async synchronizeAll(): Promise<void> {
		this.fullPass = true;
		await this.settle();
	}

	async getSources(): Promise<Block[]> {
		await this.settle();
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
		await this.settle();
		const paths = this.sourcePathsById.get(id);
		if (!paths || paths.size !== 1) return null;
		return this.readSource([...paths][0]!, id);
	}

	async filesForId(id: string): Promise<FileText[]> {
		await this.settle();
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
		const refs = Object.entries(this.knownRefs);
		const keptRefs = refs.filter(([key]) => changeKeyId(key) !== id);
		const hadHash = Object.prototype.hasOwnProperty.call(this.hashes, id);
		if (hadHash || keptRefs.length !== refs.length) this.unsaved = true;
		delete this.hashes[id];
		this.knownRefs = Object.fromEntries(keptRefs);
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
		this.schedule(delay);
	}

	private schedule(delay: number): void {
		this.cancelTimer();
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.settle();
		}, delay);
	}

	private cancelTimer(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	/** Starts the work loop unless it is running, and resolves when it runs out of due work. */
	private settle(): Promise<void> {
		return (this.working ??= this.work());
	}

	private async work(): Promise<void> {
		// The first step always awaits, so `working` is set before the finally clears it.
		try {
			do {
				const full = this.fullPass;
				this.fullPass = false;
				await this.updateIndex(full);
				// Queued IDs wait out the debounce; a full pass takes them with every indexed ID.
				if (!full && this.timer !== null) continue;
				const ids = new Set([...this.queuedIds, ...(full ? this.pathsById.keys() : [])]);
				this.queuedIds.clear();
				if (ids.size || full) await this.synchronize(ids);
			} while (
				this.fullPass ||
				!this.indexReady ||
				!this.indexValidated ||
				(this.timer === null && this.queuedIds.size > 0)
			);
		} finally {
			this.working = null;
		}
	}

	private async synchronize(ids: Set<string>): Promise<void> {
		try {
			const scope = await this.expandNestedScope(ids);
			ids = scope.ids;
			const paths = scope.files.map((file) => file.path);
			// Every note in scope is parsed, so its parse errors clear by path. Block errors
			// clear only for the blocks this pass reached, keyed by block ID.
			const issues = new Map(scope.parseErrors);
			const reportIssues = async (): Promise<void> => {
				await this.persist();
				// A note or ID that left the index mid-pass was already cleared, and nothing
				// would re-check an issue reported for it now.
				for (const path of paths) if (!this.files.has(path)) issues.delete(path);
				for (const id of ids)
					if (!this.pathsById.has(id)) issues.delete(blockIssueKey(id));
				this.callbacks.onIssues(issues);
			};
			if ([...issues.values()].some((errors) => errors.length)) {
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
				// Every note in scope parsed cleanly above, so each ID only needs the notes that
				// mention it. The prefix test is a superset; planSync ignores the extra blocks.
				const plan = planSync(
					scanned.filter((file) => file.text.includes(`<!--#${id}`)),
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
			if (!sameEntries(this.hashes, nextHashes) || !sameEntries(this.knownRefs, nextRefs))
				this.unsaved = true;
			this.hashes = nextHashes;
			this.knownRefs = nextRefs;
			this.clearLocalChanges(ids);
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
				this.queue(ids, SYNC_DELAY);
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
		}
	}

	private async expandNestedScope(
		requested: ReadonlySet<string>,
	): Promise<{ ids: Set<string>; files: FileText[]; parseErrors: Map<string, string[]> }> {
		// An ID that left the index has no copies left, so there is nothing to synchronize.
		const ids = new Set([...requested].filter((id) => this.pathsById.has(id)));
		// Each note is read and parsed once; the guarded write catches a note changed since.
		const scanned = new Map<string, { file: FileText; blocks: Block[]; errors: string[] }>();
		let changed = true;
		while (changed) {
			changed = false;
			const unread = new Set(
				[...ids].flatMap((id) => [...(this.pathsById.get(id) ?? [])]),
			);
			for (const path of scanned.keys()) unread.delete(path);
			for (const file of await this.readFiles(unread))
				scanned.set(file.path, { file, ...parseFile(file.path, file.text) });
			for (const { blocks } of scanned.values())
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
		const entries = [...scanned.values()];
		return {
			ids,
			files: entries.map((entry) => entry.file),
			parseErrors: new Map(entries.map((entry) => [entry.file.path, entry.errors])),
		};
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
			// the same note open in two panes). Validate all
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

	// Only the loop calls this, so dirty notes are never scanned twice at once.
	private async updateIndex(force: boolean): Promise<void> {
		if (this.indexReady && this.indexValidated && !force) return;
		if (force || !this.indexReady) await this.scanVault();
		while (!this.indexValidated) await this.refreshChangedFiles();
		await this.persist();
	}

	private async scanVault(): Promise<void> {
		const startedAt = Date.now();
		// A save before the scan completes holds a partial index, so it must not vouch for any note.
		this.indexedThrough = 0;
		const previousPaths = [...this.files.keys()];
		const previousIds = [...this.pathsById.keys()];
		this.files.clear();
		this.pathsById.clear();
		this.sourcePathsById.clear();
		this.dirtyPaths.clear();
		this.unsaved = true;
		this.changedSince = null;
		const files = this.plugin.app.vault.getMarkdownFiles();
		for (let i = 0; i < files.length; i += INDEX_CHUNK_SIZE) {
			for (const file of files.slice(i, i + INDEX_CHUNK_SIZE))
				await this.scanFile(file);
			await yieldToUi();
		}
		this.clearIssuesLeftIndex(previousPaths, previousIds);
		this.indexReady = true;
		this.markValidated(startedAt);
	}

	private async refreshChangedFiles(): Promise<void> {
		const startedAt = Date.now();
		const dirty = new Set(this.dirtyPaths);
		for (const path of dirty) this.dirtyPaths.delete(path);
		// An outside edit re-checks the open blocks a dirty note held before or after its rescan.
		const queueOpen = (): void => {
			for (const path of dirty)
				for (const id of this.files.get(path)?.ids ?? [])
					if (this.activeIds.has(id)) this.queuedIds.add(id);
		};
		queueOpen();
		const since = this.changedSince;
		this.changedSince = null;
		// ctime is creation time: it catches a note copied in with an older, preserved mtime.
		// shortcut: an existing unindexed note overwritten in place with an older mtime is missed
		// until it changes again or Sync now runs; catching it means storing every note's stat.
		if (since !== null)
			for (const file of this.plugin.app.vault.getMarkdownFiles())
				if (
					!this.files.has(file.path) &&
					Math.max(file.stat.mtime, file.stat.ctime) > since
				)
					dirty.add(file.path);
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
		queueOpen();
		this.indexReady = true;
		this.markValidated(startedAt);
	}

	private async scanFile(file: TFile): Promise<void> {
		try {
			const live = this.liveDocument(file.path);
			const text = live?.read() ?? (await this.plugin.app.vault.read(file));
			this.indexText(file.path, text, file.stat.mtime, file.stat.size);
		} catch (error) {
			this.scanFailed = true;
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
		const previous = this.files.get(path);
		// Typing re-indexes the note on every keystroke; an unchanged entry needs no rewrite.
		if (previous && indexed && sameIndexEntry(previous, indexed)) return;
		const previousIds = [...(previous?.ids ?? [])];
		const wasIndexed = previous !== undefined;
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
		this.unsaved = true;
		this.files.set(path, indexed);
		for (const id of indexed.ids) addPath(this.pathsById, id, path);
		for (const id of indexed.sourceIds)
			addPath(this.sourcePathsById, id, path);
	}

	private removeIndexedPath(path: string): void {
		const previous = this.files.get(path);
		if (!previous) return;
		this.unsaved = true;
		for (const id of previous.ids) removePath(this.pathsById, id, path);
		for (const id of previous.sourceIds)
			removePath(this.sourcePathsById, id, path);
		this.files.delete(path);
	}


	private clearLocalChanges(ids: ReadonlySet<string>): void {
		for (const key of this.localChanges)
			if (ids.has(changeKeyId(key)))
				this.localChanges.delete(key);
	}

	// One save runs at a time, so a change made during a save is written by the next one.
	private persist(): Promise<void> {
		const run = this.saveQueue.then(() => this.save());
		this.saveQueue = run.catch(() => undefined);
		return run;
	}

	private async save(): Promise<void> {
		if (!this.unsaved) return;
		const data = createStoredSyncData(
			this.hashes,
			this.knownRefs,
			this.files,
			this.indexedThrough,
		);
		this.unsaved = false;
		try {
			await this.plugin.saveData(data);
		} catch (error) {
			this.unsaved = true;
			throw error;
		}
	}

	/**
	 * Records that notes changed before `startedAt` are indexed, once nothing is left to check.
	 * The time is saved but doesn't mark the data unsaved: a stale time only rescans more notes.
	 */
	private markValidated(startedAt: number): void {
		this.indexValidated = this.dirtyPaths.size === 0 && this.changedSince === null;
		if (this.indexValidated && !this.scanFailed) this.indexedThrough = startedAt;
	}
}

function sameIndexEntry(a: IndexedFile, b: IndexedFile): boolean {
	return (
		a.mtime === b.mtime &&
		a.size === b.size &&
		sameSet(a.ids, b.ids) &&
		sameSet(a.sourceIds, b.sourceIds)
	);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	return a.size === b.size && [...a].every((value) => b.has(value));
}

function sameEntries<T>(a: Record<string, T>, b: Record<string, T>): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
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

/** Keys of blocks whose body differs from, or is missing in, `previous`. */
function changedBlockKeys(
	previous: ReadonlyMap<string, string>,
	current: ReadonlyMap<string, string>,
): string[] {
	return [...current].flatMap(([key, body]) => (previous.get(key) === body ? [] : [key]));
}

/** Change keys carry the block ID as their second field (see `sourceChangeKey`). */
function changeKeyId(key: string): string {
	return key.split('\u0000')[1] ?? '';
}

function blockBodiesByKey(path: string, blocks: Block[]): Map<string, string> {
	const result = new Map<string, string>();
	const ordinals = new Map<string, number>();
	for (const block of blocks) {
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
