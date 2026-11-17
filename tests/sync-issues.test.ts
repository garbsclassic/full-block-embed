import assert from 'node:assert/strict';
import test from 'node:test';
import { blockIssueKey, INTERRUPTED_ISSUE_KEY, SyncIssues } from '../src/sync-issues.ts';

const P_FOO_ERROR = 'P.md:2: unclosed source block foo (closing marker is missing)';
const Q_FOO_ERROR = 'Q.md:2: unclosed source block foo (closing marker is missing)';

test('reporting an empty list for a key clears that key and keeps the others', () => {
	const issues = new SyncIssues();
	issues.report(
		new Map([
			['A.md', ['A.md:1: first']],
			['B.md', ['B.md:1: second']],
		]),
	);

	issues.report(new Map([['A.md', []]]));

	assert.deepEqual(issues.list, ['B.md:1: second']);
});

test('reporting a key again replaces its earlier messages instead of appending', () => {
	const issues = new SyncIssues();
	issues.report(new Map([['A.md', ['A.md:1: stale']]]));

	issues.report(new Map([['A.md', ['A.md:2: current']]]));

	assert.deepEqual(issues.list, ['A.md:2: current']);
});

test('a message reported under two keys is listed once', () => {
	const issues = new SyncIssues();
	const shared = 'y: conflicting edits in A.md, B.md';
	issues.report(
		new Map([
			['A.md', [shared]],
			[blockIssueKey('y'), [shared]],
		]),
	);

	assert.deepEqual(issues.list, [shared]);
});

test('renaming moves the key, so only the new key clears the issue', () => {
	const issues = new SyncIssues();
	issues.report(new Map([['P.md', [P_FOO_ERROR]]]));

	issues.rename('P.md', 'Q.md');
	issues.clear(['P.md']);
	assert.deepEqual(issues.list, [Q_FOO_ERROR]);

	issues.clear(['Q.md']);
	assert.deepEqual(issues.list, []);
});

test('renaming rewrites only messages that start with the old path and a colon', () => {
	const issues = new SyncIssues();
	issues.report(
		new Map([
			['P.md', [P_FOO_ERROR]],
			[blockIssueKey('x'), ['P.md:3: outside edit for shared block x differs']],
			['C.md', ['P.md.md:1: unclosed reference block z (closing marker is missing)']],
			['D.md', ['sub/P.md:1: unclosed source block w (closing marker is missing)']],
			[blockIssueKey('y'), ['y: conflicting edits in P.md, C.md']],
		]),
	);

	issues.rename('P.md', 'Q.md');

	assert.deepEqual([...issues.list].sort(), [
		'P.md.md:1: unclosed reference block z (closing marker is missing)',
		'Q.md:2: unclosed source block foo (closing marker is missing)',
		'Q.md:3: outside edit for shared block x differs',
		'sub/P.md:1: unclosed source block w (closing marker is missing)',
		'y: conflicting edits in P.md, C.md',
	]);
});

test('clearing keys that hold no issue leaves the list unchanged', () => {
	const issues = new SyncIssues();
	issues.report(new Map([['A.md', ['A.md:1: first']]]));

	issues.clear(['Unknown.md', blockIssueKey('nope'), INTERRUPTED_ISSUE_KEY]);

	assert.deepEqual(issues.list, ['A.md:1: first']);
});
