import {
	StateField,
	type EditorState,
	type Extension,
	type Range,
} from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	EditorView as CodeMirrorEditorView,
	type ViewUpdate,
	ViewPlugin,
	WidgetType,
} from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { applyPatches, Block, parseFile, type Patch } from './blocks';
import { addIconButton } from './ui';

export interface EditingActions {
	openSource: (id: string) => void;
	decoupleReference: (view: CodeMirrorEditorView, block: Block) => void;
	removeReference: (view: CodeMirrorEditorView, block: Block) => void;
	convertSource: (view: CodeMirrorEditorView, block: Block) => void;
	observeEditor: (
		owner: object,
		path: string,
		text: string,
		document: {
			read(): string;
			apply(patches: Patch[]): boolean;
		},
		editedInObsidian: boolean,
	) => void;
	unobserveEditor: (owner: object, markersRemovedFrom?: string) => void;
}

class BlockControlsWidget extends WidgetType {
	constructor(
		private block: Block,
		private actions: EditingActions,
	) {
		super();
	}
	eq(other: BlockControlsWidget): boolean {
		return (
			other.block.id === this.block.id &&
			other.block.kind === this.block.kind &&
			other.block.start === this.block.start
		);
	}
	toDOM(view: CodeMirrorEditorView): HTMLElement {
		const controls = createSpan({
			cls: 'full-block-embed-editing-controls',
		});
		if (this.block.kind === '=') {
			addIconButton(controls, {
				icon: 'arrow-up-right',
				title: `Open source: ${this.block.id}`,
				run: () => this.actions.openSource(this.block.id),
			});
			addIconButton(controls, {
				icon: 'unlink',
				title: `Convert reference to normal text: ${this.block.id}`,
				run: () => this.actions.decoupleReference(view, this.block),
			});
			addIconButton(controls, {
				icon: 'trash-2',
				title: `Delete reference: ${this.block.id}`,
				run: () => this.actions.removeReference(view, this.block),
			});
		} else {
			addIconButton(controls, {
				icon: 'unlink',
				title: `Convert shared block to normal text: ${this.block.id}`,
				run: () => this.actions.convertSource(view, this.block),
			});
		}
		return controls;
	}
}

function decorations(
	state: EditorState,
	actions: EditingActions,
): DecorationSet {
	const ranges: Array<Range<Decoration>> = [];
	const text = state.doc.toString();
	if (!text.includes('<!--#')) return Decoration.none;
	const path = state.field(editorInfoField, false)?.file?.path || '';
	const blocks = parseFile(path, text).blocks;
	for (const block of blocks) {
		const first = state.doc.lineAt(
			Math.min(block.bodyStart, state.doc.length),
		);
		ranges.push(
			Decoration.line({ class: 'full-block-embed-editing-first' }).range(
				first.from,
			),
		);
		ranges.push(
			Decoration.widget({
				widget: new BlockControlsWidget(block, actions),
				side: 1,
			}).range(first.to),
		);
	}
	return Decoration.set(ranges, true);
}

export function editingExtension(actions: EditingActions): Extension {
	const observer = ViewPlugin.fromClass(
		class {
			constructor(private view: CodeMirrorEditorView) {
				this.publish(false);
			}

			update(update: ViewUpdate): void {
				const oldPath = update.startState.field(editorInfoField, false)
					?.file?.path;
				const path = update.state.field(editorInfoField, false)?.file
					?.path;
				if (update.docChanged || oldPath !== path)
					// A document transaction in an Obsidian editor is an approved
					// in-app change even when Obsidian or an input method omits the
					// CodeMirror user-event annotation. Filesystem changes still take
					// the guarded outside-edit path because they do not pass here.
					this.publish(update.docChanged);
			}

			destroy(): void {
				actions.unobserveEditor(this);
			}

			private publish(editedInObsidian: boolean): void {
				const path = this.view.state.field(editorInfoField, false)?.file
					?.path;
				const text = this.view.state.doc.toString();
				if (!path || !text.includes('<!--#')) {
					actions.unobserveEditor(this, path);
					return;
				}
				actions.observeEditor(
					this,
					path,
					text,
					{
						read: () => this.view.state.doc.toString(),
						apply: (patches) => this.apply(patches),
					},
					editedInObsidian,
				);
			}

			private apply(patches: Patch[]): boolean {
				const current = this.view.state.doc.toString();
				try {
					applyPatches(current, patches);
				} catch {
					return false;
				}
				this.view.dispatch({
					changes: [...patches]
						.sort((a, b) => a.from - b.from)
						.map((patch) => ({
							from: patch.from,
							to: patch.to,
							insert: patch.body,
						})),
				});
				return true;
			}
		},
	);
	const field = StateField.define<DecorationSet>({
		create: (state) => decorations(state, actions),
		update: (current, transaction) => {
			const oldPath = transaction.startState.field(editorInfoField, false)
				?.file?.path;
			const path = transaction.state.field(editorInfoField, false)?.file
				?.path;
			return transaction.docChanged || oldPath !== path
				? decorations(transaction.state, actions)
				: current;
		},
		provide: (value) => CodeMirrorEditorView.decorations.from(value),
	});
	return [
		observer,
		field,
		CodeMirrorEditorView.atomicRanges.of((view) => view.state.field(field)),
	];
}
