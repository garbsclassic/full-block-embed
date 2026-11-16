import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const json = async (path: string): Promise<Record<string, unknown>> =>
	JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

test('Obsidian and npm release metadata stay aligned', async () => {
	const [manifest, packageJson, versions] = await Promise.all([
		json('manifest.json'),
		json('package.json'),
		json('versions.json'),
	]);

	assert.equal(packageJson.name, manifest.id);
	assert.equal(packageJson.version, manifest.version);
	assert.equal(versions[String(manifest.version)], manifest.minAppVersion);
	assert.match(String(manifest.id), /^[a-z0-9-]+$/);
	assert.equal(typeof manifest.description, 'string');
	assert.notEqual(manifest.description, '');
	assert.match(String(manifest.description), /\.$/);
	assert.equal(manifest.fundingUrl, undefined);
});

// Older releases already use the APIs that set minAppVersion, so none may advertise a lower floor.
test('no release advertises an Obsidian floor below minAppVersion', async () => {
	const [manifest, versions] = await Promise.all([
		json('manifest.json'),
		json('versions.json'),
	]);
	const parts = (version: unknown) => String(version).split('.').map(Number);
	const floor = parts(manifest.minAppVersion);

	for (const [release, appVersion] of Object.entries(versions)) {
		const app = parts(appVersion);
		const index = app.findIndex((part, i) => part !== floor[i]);
		assert.ok(
			index === -1 || app[index]! > floor[index]!,
			`${release} requires Obsidian ${String(appVersion)}, below ${String(manifest.minAppVersion)}`,
		);
	}
});

test('license preserves current and upstream attribution', async () => {
	const [license, notices] = await Promise.all([
		readFile('LICENSE', 'utf8'),
		readFile('THIRD_PARTY_NOTICES.md', 'utf8'),
	]);

	for (const notice of ['Copyright (c) 2026 Matt Troncali'])
		assert.match(license, new RegExp(notice.replace(/[()]/g, '\\$&')));
	for (const upstream of [
		'Copyright (c) 2025 Verity',
		'Copyright (c) 2026 Siulved54',
	])
		assert.match(notices, new RegExp(upstream.replace(/[()]/g, '\\$&')));
	assert.match(notices, /github\.com\/uthvah\/sync-embeds/);
	assert.match(
		notices,
		/github\.com\/perezamadorluisenrique-gif\/shared-blocks/,
	);
});
