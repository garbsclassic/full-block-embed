/**
 * Sync issues keyed by what a later pass re-checks: a note path for its parse errors,
 * `blockIssueKey(id)` for one block's errors, or `INTERRUPTED_ISSUE_KEY` for a pass that threw.
 */
export const INTERRUPTED_ISSUE_KEY = '';

// Obsidian forbids ':' in note names, so a block key never equals a path.
export const blockIssueKey = (id: string): string => `block:${id}`;

export class SyncIssues {
	private byKey = new Map<string, string[]>();

	get list(): string[] {
		return [...new Set([...this.byKey.values()].flat())];
	}

	/** An empty list clears that key. */
	report(issues: ReadonlyMap<string, string[]>): void {
		for (const [key, errors] of issues)
			if (errors.length) this.byKey.set(key, errors);
			else this.byKey.delete(key);
	}

	clear(keys: Iterable<string>): void {
		for (const key of keys) this.byKey.delete(key);
	}

	/** Moves a renamed note's issues and repoints every issue that names its old path. */
	rename(from: string, to: string): void {
		const prefix = `${from}:`;
		const moved = new Map<string, string[]>();
		for (const [key, errors] of this.byKey)
			moved.set(
				key === from ? to : key,
				errors.map((error) =>
					error.startsWith(prefix) ? `${to}:${error.slice(prefix.length)}` : error,
				),
			);
		this.byKey = moved;
	}
}
