import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { collectReleaseArtifacts, generatePackageManifests } from '../package-manifests.mjs';

const execute = promisify(execFile);

test('package manifests use actual artifact hashes, per-architecture assets, and local Flatpak inputs', async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sidex packaging '));
	try {
		const artifacts = path.join(temporary, 'artifacts');
		await fs.mkdir(artifacts);
		const files = [
			'SideX_0.1.3_x64-setup.exe',
			'SideX_0.1.3_arm64-setup.exe',
			'SideX_0.1.3_x64.dmg',
			'macos-arm64--SideX_0.1.3_aarch64.dmg',
			'SideX_0.1.3_amd64.deb'
		];
		for (const filename of files) await fs.writeFile(path.join(artifacts, filename), `fixture bytes for ${filename}`);
		const output = path.join(temporary, 'manifests');
		const result = await generatePackageManifests({ version: 'v0.1.3', artifacts, output });
		assert.equal(result.artifacts.length, 5);
		const installer = JSON.parse(await fs.readFile(path.join(output, 'winget/Naulbi.SideX.installer.yaml'), 'utf8'));
		assert.equal(installer.Installers.length, 4);
		assert.equal(installer.Installers.find(item => item.Scope === 'machine').InstallerSwitches.Custom, '/AllUsers');
		assert.equal(installer.Installers.find(item => item.Scope === 'user').InstallerSwitches.Custom, '/CurrentUser');
		const x64 = installer.Installers.find(item => item.Architecture === 'x64');
		assert.equal(
			x64.InstallerSha256,
			createHash('sha256').update(`fixture bytes for ${files[0]}`).digest('hex').toUpperCase()
		);
		assert.match(x64.InstallerUrl, /\/releases\/download\/v0\.1\.3\/SideX_0\.1\.3_x64-setup\.exe$/);
		const cask = await fs.readFile(path.join(output, 'sidex.rb'), 'utf8');
		assert.match(cask, /on_arm do/);
		assert.match(cask, /on_intel do/);
		assert.doesNotMatch(cask, /:no_check/);
		const directory = path.join(output, 'flatpak/x64');
		const local = JSON.parse(await fs.readFile(path.join(directory, 'manifest.local.json'), 'utf8'));
		const published = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
		assert.equal(local.runtime, 'org.gnome.Platform');
		const localSource = local.modules[1].sources[0];
		assert.equal(path.resolve(directory, localSource.path), path.join(artifacts, files[4]));
		assert.equal(published.modules[1].sources[0].sha256, result.artifacts.find(item => item.type === 'deb').sha256);
		assert(local.modules[1]['build-commands'].includes('test -x usr/lib/SideX/runtime/node/bin/node'));
		assert(local.modules[1]['build-commands'].some(command => command.includes('/app/lib/SideX')));
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});

test('mismatched release versions and empty artifacts cannot produce plausible manifests', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidex artifacts '));
	try {
		await fs.writeFile(path.join(directory, 'SideX_9.9.9_x64-setup.exe'), 'bytes');
		await assert.rejects(collectReleaseArtifacts(directory, '0.1.3', 'https://example.com/releases'), /does not match/);
		await fs.rm(path.join(directory, 'SideX_9.9.9_x64-setup.exe'));
		await fs.writeFile(path.join(directory, 'SideX_0.1.3_x64-setup.exe'), '');
		await assert.rejects(
			collectReleaseArtifacts(directory, '0.1.3', 'https://example.com/releases'),
			/Empty release artifact/
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test(
	'Flatpak extraction accepts xz-compressed Debian data and preserves resource paths',
	{ skip: process.platform !== 'linux' },
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidex deb '));
		try {
			const source = path.join(directory, 'source');
			await fs.mkdir(path.join(source, 'usr/lib/SideX/extension-host'), { recursive: true });
			await fs.writeFile(path.join(source, 'usr/lib/SideX/extension-host/host.cjs'), 'runtime payload');
			await execute('tar', ['-cJf', path.join(directory, 'data.tar.xz'), '-C', source, 'usr']);
			await execute('ar', ['rc', 'sidex.deb', 'data.tar.xz'], { cwd: directory });
			const script = fileURLToPath(new URL('../../packaging/flatpak/extract-deb.sh', import.meta.url));
			await execute('sh', [script, 'sidex.deb'], { cwd: directory });
			assert.equal(
				await fs.readFile(path.join(directory, 'usr/lib/SideX/extension-host/host.cjs'), 'utf8'),
				'runtime payload'
			);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	}
);
