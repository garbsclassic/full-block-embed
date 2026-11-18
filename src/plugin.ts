import { EditorView as CodeMirrorEditorView } from '@codemirror/view';
import {
	Editor,
	MarkdownView,
	Menu,
	Notice,
	Platform,
	Plugin,
	TFile,
} from 'obsidian';
import {
	Block,
	FileText,
	parseFile,
	referenceBody,
	removeBlock,
	unwrapBlock,
} from './blocks';
import { editingExtension, type EditingActions } from './editor';
import { ReadingViewRenderer, type ReferenceLocator } from './reading-view';
import { SourceEditor } from './source-editor';
import { SyncIssues } from './sync-issues';
import { BlockSyncManager, type LegacyStoredSyncData } from './sync-manager';
import { BlockPicker, ConfirmModal, IdModal } from './ui';

export default class FullBlockEmbed extends Plugin {
	private issueStatus!: HTMLElement;
	private issues = new SyncIssues();
	private readingView: ReadingViewRenderer | null = null;
	private pendingReadingFiles = new Map<string, string | undefined>();
	private readingRefreshFrame: number | null = null;
	private sourceEditor!: SourceEditor;
	private sync!: BlockSyncManager;

	async onload(): Promise<void> {
		this.issueStatus = this.addStatusBarItem();
		this.issueStatus.addClass('mod-clickable');
		this.issueStatus.hide();
		this.registerDomEvent(this.issueStatus, 'click', () =>
			this.openFirstIssue(),
		);
		this.sync = new BlockSyncManager(this, {
			onIssues: (issues) => this.updateIssues(() => this.issues.report(issues)),
			onClearIssues: (keys) => this.updateIssues(() => this.issues.clear(keys)),
			onRenameIssues: (from, to) =>
				this.updateIssues(() => this.issues.rename(from, to)),
			onFilesChanged: (files) => this.refreshReadingViews(files),
		});
		this.sync.load((await this.loadData()) as LegacyStoredSyncData | null);
		this.sourceEditor = new SourceEditor(this.app, (id) =>
			this.sync.findSource(id),
		);
		const changed = (file: unknown) => {
			if (file instanceof TFile && file.extension === 'md') {
				this.sync.markModified(file);
				void this.refreshReadingView(file.path);
			}
		};
		this.registerEvent(this.app.vault.on('modify', changed));
		this.registerEvent(this.app.vault.on('create', changed));
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === 'md')
					this.sync.markDeleted(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && file.extension === 'md')
					this.sync.markRenamed(file, oldPath);
			}),
		);
		const editingActions: EditingActions = {
			openSource: (id) => void this.sourceEditor.open(id),
			decoupleReference: (view, block) =>
				this.decoupleReferenceInEditor(view, block),
			removeReference: (view, block) =>
				this.removeReferenceInEditor(view, block),
			convertSource: (view, block) =>
				void this.confirmConvertSource(block.id, () => ({
					path: block.path,
					text: view.state.doc.toString(),
				})),
			observeEditor: (owner, path, text, document, editedInObsidian) =>
				this.sync.observe(
					owner,
					path,
					text,
					document,
					editedInObsidian,
				),
			unobserveEditor: (owner, markersRemovedFrom) =>
				this.sync.unobserve(owner, markersRemovedFrom),
		};
		this.registerEditorExtension(editingExtension(editingActions));
		this.readingView = new ReadingViewRenderer(this.app, {
			openSource: (id) => this.sourceEditor.open(id),
			removeReference: (path, id, locator) =>
				this.removeReferenceFromFile(path, id, locator),
			convertSource: (id) => this.confirmConvertSource(id),
			observeRendered: (owner, path, text) =>
				this.sync.observe(owner, path, text),
			unobserveRendered: (owner) => this.sync.unobserve(owner),
		});
		this.registerMarkdownPostProcessor((el, ctx) =>
			this.readingView?.decorate(el, ctx),
		);
		this.addCommand({
			id: 'sync-now',
			name: 'Synchronize shared blocks now',
			callback: async () => {
				await this.sync.synchronizeAll();
				if (this.issues.list.length) new Notice(this.issueSummary);
			},
		});
		this.addCommand({
			id: 'create-shared-block',
			name: 'Create shared block',
			icon: 'blocks',
			editorCallback: (editor, view) =>
				this.createSharedBlock(editor, view.file),
		});
		this.addCommand({
			id: 'insert-shared-block',
			name: 'Insert shared block reference',
			icon: 'copy-plus',
			editorCallback: (editor) => void this.insertSharedBlock(editor),
		});
		this.addCommand({
			id: 'open-shared-block-source',
			name: 'Open shared block source',
			editorCallback: (editor, view) => {
				const block = this.blockAtCursor(editor, view.file, '=');
				if (block) void this.sourceEditor.open(block.id);
				else new Notice('Cursor is not inside a shared reference');
			},
		});
		this.addCommand({
			id: 'remove-shared-block-reference',
			name: 'Delete current shared block reference',
			editorCallback: (editor, view) => {
				const block = this.blockAtCursor(editor, view.file, '=');
				if (!block) {
					new Notice('Cursor is not inside a shared reference');
					return;
				}
				this.removeReference(editor, block);
			},
		});
		this.addCommand({
			id: 'convert-shared-block-source',
			name: 'Convert current shared source to normal text',
			editorCallback: (editor, view) => {
				const block = this.blockAtCursor(editor, view.file, '+');
				if (!block) {
					new Notice('Cursor is not inside a shared source');
					return;
				}
				void this.confirmConvertSource(block.id, () =>
					view.file
						? { path: view.file.path, text: editor.getValue() }
						: undefined,
				);
			},
		});
		this.addCommand({
			id: 'open-shared-block-sync-issue',
			name: 'Open first shared block sync issue',
			checkCallback: (checking) => {
				if (!this.issues.list.length) return false;
				if (!checking) this.openFirstIssue();
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on(
				'editor-menu',
				(menu: Menu, editor: Editor, view) => {
					const block = this.blockAtCursor(editor, view.file);
					menu.addSeparator();
					if (block?.kind === '=')
						menu.addItem((item) =>
							item
								.setTitle('Delete shared block reference')
								.setIcon('trash-2')
								.onClick(() =>
									this.removeReference(editor, block),
								),
						);
					if (block?.kind === '+')
						menu.addItem((item) =>
							item
								.setTitle('Convert shared block to normal text')
								.setIcon('unlink')
								.onClick(
									() =>
										void this.confirmConvertSource(
											block.id,
											() =>
												view.file
													? {
															path: view.file
																.path,
															text: editor.getValue(),
														}
													: undefined,
										),
								),
						);
					menu.addItem((item) =>
						item
							.setTitle('Create shared block')
							.setIcon('blocks')
							.onClick(() =>
								this.createSharedBlock(editor, view.file),
							),
					);
					menu.addItem((item) =>
						item
							.setTitle('Insert shared block reference')
							.setIcon('copy-plus')
							.onClick(() => void this.insertSharedBlock(editor)),
					);
				},
			),
		);
	}
	onunload(): void {
		if (this.readingRefreshFrame !== null)
			window.cancelAnimationFrame(this.readingRefreshFrame);
		this.readingRefreshFrame = null;
		this.pendingReadingFiles.clear();
		this.sync.unload();
		this.readingView = null;
	}

	private refreshReadingViews(
		files: Array<{ path: string; text?: string }>,
	): void {
		if (!files.length) return;
		for (const file of files) {
			const pending = this.pendingReadingFiles.get(file.path);
			// A synchronized buffer is more current than a save notification that
			// happens to arrive in the same animation frame.
			this.pendingReadingFiles.set(file.path, file.text ?? pending);
			this.readingView?.invalidate(file.path);
		}
		if (this.readingRefreshFrame !== null) return;
		this.readingRefreshFrame = window.requestAnimationFrame(() => {
			this.readingRefreshFrame = null;
			const changed = new Map(this.pendingReadingFiles);
			this.pendingReadingFiles.clear();
			this.app.workspace.iterateAllLeaves((leaf) => {
				const view = leaf.view;
				if (
					view instanceof MarkdownView &&
					view.getMode() === 'preview' &&
					view.file &&
					changed.has(view.file.path)
				) {
					const text = changed.get(view.file.path);
					if (
						text !== undefined &&
						view.previewMode.get() !== text
					) {
						// Refresh the read-only preview's own buffer. Do not register it
						// as a writable sync document or request a save.
						view.data = text;
						view.previewMode.set(text, false);
					}
					view.previewMode.rerender(true);
				}
			});
		});
	}

	private async refreshReadingView(path: string): Promise<void> {
		try {
			const text = await this.sync.readCurrentText(path);
			if (text !== null) this.refreshReadingViews([{ path, text }]);
		} catch (error) {
			console.error(
				`Full Block Embed: unable to refresh Reading view for ${path}`,
				error,
			);
		}
	}

	private blockAtCursor(
		editor: Editor,
		file: TFile | null,
		kind?: '+' | '=',
	): Block | undefined {
		if (!file) return undefined;
		const line = editor.getCursor().line;
		return parseFile(file.path, editor.getValue())
			.blocks.filter(
				(block) =>
					(!kind || block.kind === kind) &&
					line >= block.startLine &&
					line <= block.endLine,
			)
			.sort(
				(a, b) =>
					b.depth - a.depth || a.end - a.start - (b.end - b.start),
			)[0];
	}
	private removeReference(editor: Editor, block: Block): void {
		editor.replaceRange(
			'',
			editor.offsetToPos(block.start),
			editor.offsetToPos(block.end),
		);
	}
	private removeReferenceInEditor(
		view: CodeMirrorEditorView,
		block: Block,
	): void {
		const latest = this.latestReference(view, block, 'delete');
		if (!latest) return;
		view.dispatch({
			changes: { from: latest.start, to: latest.end, insert: '' },
		});
	}
	/** Removes one reference's marker lines, leaving its Markdown as normal text. */
	private decoupleReferenceInEditor(
		view: CodeMirrorEditorView,
		block: Block,
	): void {
		const latest = this.latestReference(view, block, 'convert');
		if (!latest) return;
		view.dispatch({
			changes: {
				from: latest.start,
				to: latest.end,
				insert: view.state.sliceDoc(latest.bodyStart, latest.bodyEnd),
			},
		});
	}
	/** Finds `block` again in the editor's current text, since a button can outlive an edit. */
	private latestReference(
		view: CodeMirrorEditorView,
		block: Block,
		button: string,
	): Block | undefined {
		if (block.kind !== '=') return undefined;
		const latest = parseFile(block.path, view.state.doc.toString()).blocks.find(
			(candidate) =>
				candidate.kind === '=' &&
				candidate.id === block.id &&
				candidate.start === block.start,
		);
		if (!latest)
			new Notice(`This reference changed; try the ${button} button again`);
		return latest;
	}
	private async removeReferenceFromFile(
		path: string,
		id: string,
		locator: ReferenceLocator = {},
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`Note not found: ${path}`);
			return;
		}
		try {
			await this.app.vault.process(file, (current) => {
				const candidates = parseFile(path, current).blocks.filter(
					(block) => block.kind === '=' && block.id === id,
				);
				const target =
					locator.startLine === undefined
						? candidates[
								locator.occurrence ??
									(candidates.length === 1 ? 0 : -1)
							]
						: candidates.find(
								(block) =>
									block.startLine === locator.startLine,
							);
				if (!target)
					throw new Error(
						`Reference ${id} changed; reopen the note and try again`,
					);
				return removeBlock(current, target);
			});
		} catch (error) {
			new Notice(String(error), 8000);
		}
	}
	private async confirmConvertSource(
		id: string,
		live?: () => FileText | undefined,
	): Promise<void> {
		const files = await this.sync.filesForId(id);
		const current = live?.();
		if (current?.path) {
			const index = files.findIndex((file) => file.path === current.path);
			if (index >= 0) files[index] = current;
		}
		const copies = files
			.flatMap((file) => parseFile(file.path, file.text).blocks)
			.filter((block) => block.id === id);
		const sources = copies.filter((block) => block.kind === '+');
		if (sources.length !== 1) {
			new Notice(
				`Cannot convert ${id}: expected one source, found ${sources.length}`,
			);
			return;
		}
		const references = copies.filter((block) => block.kind === '=').length;
		const explanation = references
			? `This removes shared-block markers from the source and ${references} reference${references === 1 ? '' : 's'}. Their current Markdown stays in place, but the copies will no longer synchronize.`
			: 'This removes the shared-block markers and keeps the current Markdown as normal text.';
		new ConfirmModal(
			this.app,
			`Stop sharing ${id}?`,
			explanation,
			'Convert to normal text',
			() => {
				void this.convertSourceToNormal(id, live);
			},
		).open();
	}
	private async convertSourceToNormal(
		id: string,
		live?: () => FileText | undefined,
	): Promise<void> {
		try {
			const files = await this.sync.filesForId(id);
			const current = live?.();
			if (current?.path) {
				const index = files.findIndex(
					(file) => file.path === current.path,
				);
				if (index >= 0) files[index] = current;
			}
			const matches = files
				.flatMap((file) => parseFile(file.path, file.text).blocks)
				.filter((block) => block.id === id);
			if (matches.filter((block) => block.kind === '+').length !== 1) {
				throw new Error(`Cannot convert ${id}: its source changed`);
			}
			for (const scanned of files) {
				const blocks = matches
					.filter((block) => block.path === scanned.path)
					.sort((a, b) => b.start - a.start);
				if (!blocks.length) continue;
				const converted = blocks.reduce(
					(text, block) => unwrapBlock(text, block),
					scanned.text,
				);
				await this.sync.replaceFileText(
					scanned.path,
					scanned.text,
					converted,
				);
			}
			await this.sync.forget(id);
		} catch (error) {
			new Notice(String(error), 10000);
		}
	}
	private createSharedBlock(editor: Editor, file: TFile | null): void {
		if (!file) return;
		const selection = editor.getSelection();
		const from = editor.getCursor('from');
		const to = editor.getCursor('to');
		new IdModal(this.app, (id) => {
			void this.finishCreatingBlock(
				editor,
				file,
				id,
				selection,
				from,
				to,
			);
		}).open();
	}
	private async finishCreatingBlock(
		editor: Editor,
		file: TFile,
		id: string,
		selection: string,
		from: { line: number; ch: number },
		to: { line: number; ch: number },
	): Promise<void> {
		const current = editor.getValue();
		const fromOffset = editor.posToOffset(from);
		const toOffset = editor.posToOffset(to);
		if (
			parseFile(file.path, current).blocks.some(
				(block) =>
					block.kind === '=' &&
					fromOffset >= block.bodyStart &&
					toOffset <= block.bodyEnd,
			)
		) {
			new Notice(
				'Create nested sources in the source block, not in a reference',
			);
			return;
		}
		const existing = await this.sync.getSources();
		if (
			existing.some((block) => block.id === id) ||
			parseFile(file.path, current).blocks.some(
				(block) => block.id === id,
			)
		) {
			new Notice(`Shared block ${id} already exists`);
			return;
		}
		let body = selection.replace(/\n$/, '');
		let replaceFrom = from;
		let replaceTo = to;
		const line = editor.getLine(from.line);
		const prefix = editor.getRange({ line: from.line, ch: 0 }, from);
		if (/^[ \t]*$/.test(prefix) && (selection || /^[ \t]*$/.test(line))) {
			// Marker lines must not inherit whitespace that happened to be before
			// the selection/cursor. Preserve that whitespace as selected content
			// when wrapping text, but consume a wholly blank line when creating an
			// empty block.
			replaceFrom = { line: from.line, ch: 0 };
			if (selection) body = prefix + body;
			else if (from.line === to.line)
				replaceTo = { line: to.line, ch: line.length };
		}
		editor.replaceRange(
			`<!--#${id}+-->\n${body}\n<!--#${id}/-->`,
			replaceFrom,
			replaceTo,
		);
		if (!body) editor.setCursor({ line: replaceFrom.line + 1, ch: 0 });
	}
	private async insertSharedBlock(editor: Editor): Promise<void> {
		const blocks = await this.sync.getSources();
		if (!blocks.length) {
			new Notice('Create a shared source block first');
			return;
		}
		new BlockPicker(this.app, blocks, (block) => {
			editor.replaceSelection(
				`<!--#${block.id}=-->\n${referenceBody(block.body, block.path)}\n<!--#${block.id}/-->`,
			);
		}).open();
	}
	private get issueSummary(): string {
		const count = this.issues.list.length;
		return `Sync paused: ${count} issue${count === 1 ? '' : 's'}`;
	}

	private openFirstIssue(): void {
		const first = this.issues.list[0];
		if (first) void this.sourceEditor.openIssue(first);
	}

	private updateIssues(change: () => void): void {
		const wasEmpty = !this.issues.list.length;
		change();
		const [first] = this.issues.list;
		if (first === undefined) {
			this.issueStatus.hide();
			return;
		}
		this.issueStatus.setText(this.issueSummary);
		this.issueStatus.setAttr('aria-label', first);
		this.issueStatus.show();
		// Mobile has no status bar, so announce the pause once rather than per pass.
		if (wasEmpty && Platform.isMobile)
			new Notice(`Shared block sync paused: ${first}`);
	}
}
