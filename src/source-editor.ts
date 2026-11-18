import { App, MarkdownView, Notice, TFile } from 'obsidian';
import { Block } from './blocks';

export interface LocatedSource {
	block: Block;
	file: TFile;
}

export class SourceEditor {
	constructor(
		private app: App,
		private findSource: (id: string) => Promise<LocatedSource | null>,
	) {}

	async open(id: string): Promise<void> {
		const source = await this.findSource(id);
		if (!source) {
			new Notice(`Source not found for ${id}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.openFile(source.file, { state: { mode: 'source' } });
		if (!(leaf.view instanceof MarkdownView)) return;
		leaf.view.editor.setSelection(
			{ line: source.block.startLine + 1, ch: 0 },
			{ line: source.block.endLine, ch: 0 },
		);
		leaf.view.editor.scrollIntoView(
			{
				from: { line: source.block.startLine, ch: 0 },
				to: { line: source.block.endLine, ch: 0 },
			},
			true,
		);
	}

	async openIssue(issue: string): Promise<void> {
		const match = /^(.*):(\d+): /.exec(issue);
		if (!match) {
			new Notice(issue, 8000);
			return;
		}
		const path = match[1]!;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`Note not found: ${path}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.openFile(file, { state: { mode: 'source' } });
		if (!(leaf.view instanceof MarkdownView)) return;
		const line = Math.max(0, Number(match[2]!) - 1);
		const editor = leaf.view.editor;
		const text = editor.getLine(line);
		editor.setSelection({ line, ch: 0 }, { line, ch: text.length });
		editor.scrollIntoView(
			{ from: { line, ch: 0 }, to: { line, ch: text.length } },
			true,
		);
	}
}
