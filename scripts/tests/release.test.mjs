import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { releaseVersion, releaseEnvironment, verifyUpdaterSignature, collectReleaseAssets } from '../release.mjs';

function signingFixture(id = randomBytes(8)) {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
	const key = Buffer.concat([Buffer.from('Ed'), id, rawPublic]);
	const encodedPublic = Buffer.from(`untrusted comment: test public key\n${key.toString('base64')}\n`).toString(
		'base64'
	);
	return {
		id,
		publicKey: encodedPublic,
		sign(bytes) {
			const signature = sign(null, createHash('blake2b512').update(bytes).digest(), privateKey);
			const trustedComment = 'timestamp:123\tfile:fixture';
			const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), privateKey);
			const packet = Buffer.concat([Buffer.from('ED'), id, signature]);
			return Buffer.from(
				`untrusted comment: test signature\n${packet.toString('base64')}\ntrusted comment: ${trustedComment}\n${globalSignature.toString('base64')}\n`
			).toString('base64');
		}
	};
}

test('release versions normalize one v prefix and reject invalid SemVer or manifest mismatches', () => {
	assert.deepEqual(releaseVersion('v0.1.3', '0.1.3', '0.1.3'), { version: '0.1.3', tag: 'v0.1.3', prerelease: false });
	assert.equal(releaseVersion('0.1.3', '0.1.3', '0.1.3').tag, 'v0.1.3');
	assert.equal(releaseVersion('v1.2.3-rc.1+build.8', '1.2.3-rc.1+build.8', '1.2.3-rc.1+build.8').prerelease, true);
	for (const invalid of ['vv0.1.3', '01.2.3', '1.2.3-01', '1.2', '1.2.3\nversion=9.9.9']) {
		assert.throws(() => releaseVersion(invalid, invalid, invalid), /SemVer/);
	}
	assert.throws(() => releaseVersion('0.1.3', '0.1.4', '0.1.3'), /must equal/);
	assert.throws(() => releaseVersion('0.1.3', '0.1.3', '0.1.4'), /must equal/);
});

test('optional release credentials are sanitized and updater signatures prove the configured key pair', async () => {
	const input = {
		PATH: '/bin',
		APPLE_CERTIFICATE: '',
		APPLE_ID: ' ',
		TAURI_SIGNING_PRIVATE_KEY: '',
		TAURI_SIGNING_PUBLIC_KEY: '',
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'unused'
	};
	const unsigned = releaseEnvironment(input, 'darwin');
	assert.equal(unsigned.updater, false);
	assert.equal(unsigned.appleSigning, false);
	assert.equal(unsigned.config.bundle.createUpdaterArtifacts, false);
	assert.equal(unsigned.config.plugins.updater.pubkey, '');
	assert.deepEqual(unsigned.config.plugins.updater.endpoints, []);
	assert.equal(Object.hasOwn(unsigned.env, 'APPLE_CERTIFICATE'), false);
	assert.equal(Object.hasOwn(unsigned.env, 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'), false);
	assert.equal(input.APPLE_CERTIFICATE, '');
	assert.throws(() => releaseEnvironment({ TAURI_SIGNING_PRIVATE_KEY: 'private' }), /require both/);
	const fixture = signingFixture();
	assert.throws(() => releaseEnvironment({ TAURI_SIGNING_PUBLIC_KEY: fixture.publicKey }), /require both/);
	assert.throws(() => releaseEnvironment({ APPLE_CERTIFICATE: 'certificate' }, 'darwin'), /requires APPLE_CERTIFICATE/);
	const apple = {
		APPLE_CERTIFICATE: 'certificate',
		APPLE_CERTIFICATE_PASSWORD: 'literal $ password!',
		APPLE_ID: 'developer@example.test',
		APPLE_PASSWORD: 'app password',
		APPLE_TEAM_ID: 'TEAM'
	};
	assert.equal(releaseEnvironment(apple, 'darwin').appleNotarization, true);
	assert.equal(releaseEnvironment(apple, 'linux').env.APPLE_ID, undefined);
	assert.throws(() => releaseEnvironment({ ...apple, APPLE_TEAM_ID: '' }, 'darwin'), /Notarization requires/);
	const signed = releaseEnvironment(
		{
			...apple,
			TAURI_SIGNING_PRIVATE_KEY: 'private',
			TAURI_SIGNING_PUBLIC_KEY: fixture.publicKey,
			TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '  literal password $!  '
		},
		'darwin'
	);
	assert.equal(signed.config.bundle.createUpdaterArtifacts, true);
	assert.equal(signed.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, '  literal password $!  ');
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidex release signing '));
	try {
		const filename = path.join(directory, 'bundle');
		const bytes = Buffer.from('actual signed bundle bytes');
		await fs.writeFile(filename, bytes);
		const signature = fixture.sign(bytes);
		await verifyUpdaterSignature(filename, signature, fixture.publicKey);
		await assert.rejects(verifyUpdaterSignature(filename, signature, signingFixture().publicKey), /do not match/);
		await assert.rejects(
			verifyUpdaterSignature(filename, signature, signingFixture(fixture.id).publicKey),
			/does not verify/
		);
		await fs.writeFile(filename, 'changed bundle');
		await assert.rejects(verifyUpdaterSignature(filename, signature, fixture.publicKey), /does not verify/);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('artifact collection retains both Debian and RPM bundles and separates same-named macOS archives by architecture', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidex release bundles '));
	try {
		const linux = path.join(directory, 'linux');
		const output = path.join(directory, 'output');
		await fs.mkdir(linux);
		await fs.mkdir(output);
		await fs.writeFile(path.join(output, 'linux-x64--stale.AppImage.sig'), 'previous signed build');
		for (const filename of ['SideX.deb', 'SideX.rpm', 'SideX.AppImage', 'SideX.AppImage.sig'])
			await fs.writeFile(path.join(linux, filename), filename);
		const files = await collectReleaseAssets({
			directory: linux,
			output,
			prefix: 'linux-x64',
			version: '0.1.3',
			target: 'x86_64-unknown-linux-gnu'
		});
		assert.deepEqual(files.map(file => file.name).sort(), [
			'linux-x64--SideX.AppImage',
			'linux-x64--SideX.deb',
			'linux-x64--SideX.rpm'
		]);
		assert.equal(
			(await fs.readdir(output)).some(file => file.endsWith('.sig')),
			false
		);
		assert.equal(
			files.find(file => file.name.endsWith('.deb')).sha256,
			createHash('sha256').update('SideX.deb').digest('hex')
		);
		assert.equal(
			(await fs.readFile(path.join(output, 'linux-x64--checksums.sha256'), 'utf8')).split('\n').filter(Boolean).length,
			3
		);
		const mac = path.join(directory, 'mac');
		await fs.mkdir(mac);
		const fixture = signingFixture();
		const bytes = Buffer.from('macOS updater archive');
		await fs.writeFile(path.join(mac, 'SideX.app.tar.gz'), bytes);
		await fs.writeFile(path.join(mac, 'SideX.app.tar.gz.sig'), fixture.sign(bytes));
		for (const prefix of ['macos-arm64', 'macos-x64', 'macos-universal']) {
			await collectReleaseAssets({ directory: mac, output, prefix, version: '0.1.3', publicKey: fixture.publicKey });
		}
		assert.equal((await fs.readdir(output)).filter(file => file.endsWith('.app.tar.gz')).length, 3);
		await fs.rm(path.join(mac, 'SideX.app.tar.gz.sig'));
		await assert.rejects(
			collectReleaseAssets({ directory: mac, output, prefix: 'macos-arm64', publicKey: fixture.publicKey }),
			/Missing updater signature/
		);
		await fs.mkdir(path.join(linux, 'duplicate'));
		await fs.writeFile(path.join(linux, 'duplicate/SideX.deb'), 'duplicate');
		await assert.rejects(
			collectReleaseAssets({ directory: linux, output, prefix: 'linux-x64' }),
			/Duplicate release bundle/
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
