import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { launchTauri, tauriEnvironment } from '../tauri.mjs';
import { assertTarget, binaryPlatform, stageRuntime, targetPlatform } from '../stage-runtime.mjs';

test('Tauri launcher preserves Windows Path and limits the xattr shim to macOS', () => {
	const windows = { Path: 'C:\\Windows;C:\\Program Files\\nodejs', HOME: 'C:\\Users\\Dev' };
	assert.deepEqual(tauriEnvironment(windows, 'win32', '/not-used'), windows);
	assert.notEqual(tauriEnvironment(windows, 'win32', '/not-used'), windows);
	assert.deepEqual(tauriEnvironment({ PATH: '/usr/bin' }, 'linux', '/not-used'), { PATH: '/usr/bin' });
	assert.deepEqual(tauriEnvironment({ PATH: '/usr/bin' }, 'darwin', '/Source Folder/scripts/bin'), {
		PATH: '/Source Folder/scripts/bin:/usr/bin'
	});
	assert.equal(tauriEnvironment({}, 'darwin', '/shim').PATH, '/shim');
});

test('runtime staging checks ELF, Windows PE, and universal Mach-O architectures', () => {
	const elf = Buffer.alloc(128);
	elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
	elf.writeUInt16LE(62, 18);
	assert.deepEqual(binaryPlatform(elf), { platform: 'linux', architectures: ['x64'] });
	assertTarget(binaryPlatform(elf), targetPlatform('x86_64-unknown-linux-gnu'), 'node');
	assert.throws(
		() => assertTarget(binaryPlatform(elf), targetPlatform('aarch64-unknown-linux-gnu'), 'node'),
		/requires linux\/arm64/
	);
	const pe = Buffer.alloc(128);
	pe.writeUInt16LE(0x5a4d, 0);
	pe.writeUInt32LE(64, 60);
	pe.writeUInt32LE(0x00004550, 64);
	pe.writeUInt16LE(0xaa64, 68);
	assert.deepEqual(binaryPlatform(pe), { platform: 'win32', architectures: ['arm64'] });
	const universal = Buffer.alloc(128);
	universal.writeUInt32BE(0xcafebabe, 0);
	universal.writeUInt32BE(2, 4);
	universal.writeUInt32BE(0x01000007, 8);
	universal.writeUInt32BE(0x0100000c, 28);
	assert.deepEqual(binaryPlatform(universal), { platform: 'darwin', architectures: ['x64', 'arm64'] });
	assertTarget(binaryPlatform(universal), targetPlatform('universal-apple-darwin'), 'node');
	assert.throws(() => binaryPlatform(Buffer.alloc(128)), /Unrecognized executable/);
});

test('a wrong runtime target fails before replacing existing release files', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidex runtime '));
	try {
		const header = Buffer.alloc(128);
		header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
		header.writeUInt16LE(62, 18);
		const binary = path.join(directory, 'node');
		const output = path.join(directory, 'staged');
		await fs.writeFile(binary, header);
		await fs.mkdir(output);
		await fs.writeFile(path.join(output, 'manifest.json'), 'existing release');
		await assert.rejects(
			stageRuntime({ target: 'x86_64-pc-windows-msvc', node: binary, output }),
			/requires win32\/x64/
		);
		assert.equal(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'), 'existing release');
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('Tauri launcher passes paths and metacharacters as literal arguments without a shell', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidex tooling '));
	try {
		const cli = path.join(directory, 'fake cli.cjs');
		const output = path.join(directory, 'arguments.json');
		await fs.writeFile(
			cli,
			"require('node:fs').writeFileSync(process.env.ARGUMENT_OUTPUT, JSON.stringify(process.argv.slice(2)));"
		);
		const args = ['build', '--config', 'C:\\A Folder\\config.json', 'literal$(not-a-command)', 'x&y'];
		const child = launchTauri(args, { cli, cwd: directory, env: { ...process.env, ARGUMENT_OUTPUT: output } });
		const [code] = await once(child, 'close');
		assert.equal(code, 0);
		assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), args);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
