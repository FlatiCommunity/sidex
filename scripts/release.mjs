import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = {
	'aarch64-apple-darwin': { prefix: 'macos-arm64', bundles: 'dmg' },
	'x86_64-apple-darwin': { prefix: 'macos-x64', bundles: 'dmg' },
	'universal-apple-darwin': { prefix: 'macos-universal', bundles: 'dmg' },
	'x86_64-pc-windows-msvc': { prefix: 'windows-x64', bundles: 'nsis' },
	'aarch64-pc-windows-msvc': { prefix: 'windows-arm64', bundles: 'nsis' },
	'x86_64-unknown-linux-gnu': { prefix: 'linux-x64', bundles: 'deb,rpm,appimage' }
};

export function releaseVersion(input, packageVersion, tauriVersion) {
	const version = String(input ?? '')
		.trim()
		.replace(/^v/, '');
	const number = '(?:0|[1-9]\\d*)';
	const identifier = '(?:0|[1-9]\\d*|[\\dA-Za-z-]*[A-Za-z-][\\dA-Za-z-]*)';
	const semver = new RegExp(
		`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[\\dA-Za-z-]+(?:\\.[\\dA-Za-z-]+)*)?$`
	);
	if (!semver.test(version)) throw new Error('Release version must be SemVer with at most one leading v.');
	if (version !== packageVersion || version !== tauriVersion) {
		throw new Error(
			`Release version ${version} must equal package.json (${packageVersion}) and tauri.conf.json (${tauriVersion}).`
		);
	}
	return { version, tag: `v${version}`, prerelease: version.split('+')[0].includes('-') };
}

async function workspaceReleaseVersion(input = process.env.RELEASE_VERSION) {
	const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
	const tauriJson = JSON.parse(await fs.readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
	const release = releaseVersion(input, packageJson.version, tauriJson.version);
	if (process.env.RELEASE_REF_TYPE === 'tag' && process.env.RELEASE_REF_NAME !== release.tag) {
		throw new Error('The pushed tag must exactly match the normalized release tag.');
	}
	return release;
}

function decodeBase64(value, description) {
	const input = String(value ?? '').trim();
	if (!input || input.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
		throw new Error(`Invalid ${description} encoding.`);
	}
	return Buffer.from(input, 'base64');
}

function updaterPublicKey(value) {
	const lines = decodeBase64(value, 'updater public key').toString('utf8').trim().split(/\r?\n/);
	const bytes = decodeBase64(lines[1], 'minisign public key');
	if (
		!lines[0].startsWith('untrusted comment: ') ||
		lines.length !== 2 ||
		bytes.length !== 42 ||
		bytes.toString('ascii', 0, 2) !== 'Ed'
	) {
		throw new Error('TAURI_SIGNING_PUBLIC_KEY must contain the public key produced by tauri signer generate.');
	}
	return bytes;
}

/** Remove absent optional secrets: Tauri treats a present empty Apple variable as configured. */
export function releaseEnvironment(environment, platform = process.platform) {
	const env = { ...environment, CI: 'true' };
	const optional = [
		'TAURI_SIGNING_PRIVATE_KEY',
		'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
		'TAURI_SIGNING_PUBLIC_KEY',
		'APPLE_CERTIFICATE',
		'APPLE_CERTIFICATE_PASSWORD',
		'APPLE_SIGNING_IDENTITY',
		'APPLE_ID',
		'APPLE_PASSWORD',
		'APPLE_TEAM_ID'
	];
	for (const key of optional) if (typeof env[key] !== 'string' || !env[key].trim()) delete env[key];
	for (const key of [
		'TAURI_SIGNING_PRIVATE_KEY_PATH',
		'KEYCHAIN_PASSWORD',
		'APPLE_API_KEY',
		'APPLE_API_ISSUER',
		'APPLE_API_KEY_PATH'
	])
		delete env[key];
	const updater = Boolean(env.TAURI_SIGNING_PRIVATE_KEY);
	if (updater !== Boolean(env.TAURI_SIGNING_PUBLIC_KEY)) {
		throw new Error(
			'Updater artifacts require both TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PUBLIC_KEY from this fork.'
		);
	}
	if (updater) updaterPublicKey(env.TAURI_SIGNING_PUBLIC_KEY);
	else delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
	let appleSigning = false;
	let appleNotarization = false;
	if (platform !== 'darwin') {
		for (const key of optional.filter(key => key.startsWith('APPLE_'))) delete env[key];
	} else {
		appleSigning = Boolean(env.APPLE_CERTIFICATE);
		if (appleSigning !== Boolean(env.APPLE_CERTIFICATE_PASSWORD) || (!appleSigning && env.APPLE_SIGNING_IDENTITY)) {
			throw new Error('Apple signing requires APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD together.');
		}
		const notarization = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
		const supplied = notarization.filter(key => env[key]).length;
		if (supplied && (supplied !== notarization.length || !appleSigning)) {
			throw new Error('Notarization requires Apple signing plus APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID.');
		}
		appleNotarization = supplied === notarization.length;
	}
	return {
		env,
		updater,
		appleSigning,
		appleNotarization,
		config: {
			bundle: { createUpdaterArtifacts: updater, macOS: { signingIdentity: env.APPLE_SIGNING_IDENTITY ?? null } },
			plugins: { updater: { pubkey: env.TAURI_SIGNING_PUBLIC_KEY?.trim() ?? '', endpoints: [] } }
		}
	};
}

/** Verify Tauri's base64-wrapped minisign Ed25519/BLAKE2b signatures, including the trusted comment. */
export async function verifyUpdaterSignature(filename, encodedSignature, encodedPublicKey) {
	const publicKey = updaterPublicKey(encodedPublicKey);
	const lines = decodeBase64(encodedSignature, 'updater signature').toString('utf8').trim().split(/\r?\n/);
	if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ')) {
		throw new Error('Invalid updater signature format.');
	}
	const signature = decodeBase64(lines[1], 'minisign signature');
	const globalSignature = decodeBase64(lines[3], 'minisign comment signature');
	if (signature.length !== 74 || globalSignature.length !== 64 || signature.toString('ascii', 0, 2) !== 'ED') {
		throw new Error('Unsupported updater signature algorithm or length.');
	}
	if (!signature.subarray(2, 10).equals(publicKey.subarray(2, 10)))
		throw new Error('Updater private/public keys do not match.');
	const key = createPublicKey({
		key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey.subarray(10)]),
		format: 'der',
		type: 'spki'
	});
	const hash = createHash('blake2b512');
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	const signatureBytes = signature.subarray(10);
	const comment = Buffer.from(lines[2].slice('trusted comment: '.length).trim());
	if (
		!verify(null, hash.digest(), key, signatureBytes) ||
		!verify(null, Buffer.concat([signatureBytes, comment]), key, globalSignature)
	) {
		throw new Error("Updater signature does not verify with this fork's public key.");
	}
}

const archive =
	/(?:\.dmg|\.msi|\.deb|\.rpm|\.AppImage|-setup\.exe|\.app\.tar\.gz|\.AppImage\.tar\.gz|\.(?:exe|nsis|msi)\.zip)$/;
const updaterOnly = /(?:\.app\.tar\.gz|\.AppImage\.tar\.gz|\.(?:exe|nsis|msi)\.zip)$/;
async function bundleFiles(directory) {
	const files = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory() && !entry.name.endsWith('.app')) files.push(...(await bundleFiles(filename)));
		else if (entry.isFile() && archive.test(entry.name.replace(/\.sig$/, ''))) files.push(filename);
	}
	return files.sort();
}

export async function collectReleaseAssets({ directory, output, prefix, target, version, publicKey }) {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(prefix)) throw new Error('Invalid architecture prefix.');
	const files = (await bundleFiles(directory)).filter(
		file => publicKey || (!file.endsWith('.sig') && !updaterOnly.test(file))
	);
	if (!files.length) throw new Error('No release bundles were generated.');
	const names = new Set();
	for (const filename of files) {
		const basename = path.basename(filename);
		if (names.has(basename)) throw new Error(`Duplicate release bundle: ${basename}`);
		names.add(basename);
		if (!(await fs.stat(filename)).size) throw new Error(`Empty release bundle: ${basename}`);
		if (publicKey && filename.endsWith('.sig')) {
			await verifyUpdaterSignature(filename.slice(0, -4), await fs.readFile(filename, 'utf8'), publicKey);
		} else if (publicKey && !filename.endsWith('.dmg') && !files.includes(`${filename}.sig`)) {
			throw new Error(`Missing updater signature for ${basename}`);
		}
	}
	await fs.mkdir(output, { recursive: true });
	// Remove this target's previous generated assets, including signatures from a
	// prior signed run. Other architectures in a shared output directory remain.
	for (const entry of await fs.readdir(output, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.startsWith(`${prefix}--`)) await fs.unlink(path.join(output, entry.name));
	}
	const assets = [];
	for (const filename of files) {
		const name = `${prefix}--${path.basename(filename)}`;
		await fs.copyFile(filename, path.join(output, name));
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(filename)) hash.update(chunk);
		assets.push({ name, sha256: hash.digest('hex') });
	}
	await fs.writeFile(
		path.join(output, `${prefix}--checksums.sha256`),
		assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join('')
	);
	await fs.writeFile(
		path.join(output, `${prefix}--manifest.json`),
		JSON.stringify({ target, version, updater: Boolean(publicKey), assets }, null, 2) + '\n'
	);
	return assets;
}

function runTauri(args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(root, 'scripts/tauri.mjs'), ...args], {
			cwd: root,
			env,
			stdio: 'inherit'
		});
		child.once('error', reject);
		child.once('close', code => (code === 0 ? resolve() : reject(new Error(`Tauri failed with exit code ${code}.`))));
	});
}

async function buildRelease(target, prefix) {
	const specification = targets[target];
	if (!specification || prefix !== specification.prefix)
		throw new Error('Unknown release target or architecture prefix.');
	const { version } = await workspaceReleaseVersion();
	const plan = releaseEnvironment(process.env);
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sidex-release-'));
	try {
		if (plan.updater) {
			// Tauri only warns on a mismatched pair. Fail before compiling or creating a release instead.
			const challenge = path.join(temporary, 'key-check');
			await fs.writeFile(challenge, randomBytes(64));
			await runTauri(
				['signer', 'sign', ...(!plan.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ? ['--password', ''] : []), challenge],
				plan.env
			);
			await verifyUpdaterSignature(
				challenge,
				await fs.readFile(`${challenge}.sig`, 'utf8'),
				plan.env.TAURI_SIGNING_PUBLIC_KEY
			);
		}
		const config = path.join(temporary, 'tauri.release.json');
		await fs.writeFile(config, JSON.stringify(plan.config));
		console.log(
			`Building ${prefix}: updater=${plan.updater}, Apple signing=${plan.appleSigning}, notarization=${plan.appleNotarization}.`
		);
		const bundleDirectory = path.join(root, 'target', target, 'release/bundle');
		await fs.rm(bundleDirectory, { recursive: true, force: true });
		// The configured beforeBuildCommand runs the frontend build exactly once.
		await runTauri(
			['build', '--ci', '--target', target, '--bundles', specification.bundles, '--config', config],
			plan.env
		);
		const assets = await collectReleaseAssets({
			directory: bundleDirectory,
			output: path.join(root, 'dist-artifacts'),
			prefix,
			target,
			version,
			publicKey: plan.env.TAURI_SIGNING_PUBLIC_KEY
		});
		console.log(`Collected ${assets.length} verified release assets for ${prefix}.`);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv[2] === 'version') {
			const result = await workspaceReleaseVersion();
			if (process.env.GITHUB_OUTPUT)
				await fs.appendFile(
					process.env.GITHUB_OUTPUT,
					Object.entries(result)
						.map(([key, value]) => `${key}=${value}\n`)
						.join('')
				);
			console.log(`Validated release ${result.tag}.`);
		} else if (process.argv[2] === 'build') await buildRelease(process.argv[3], process.argv[4]);
		else throw new Error('Usage: node scripts/release.mjs version | build <target> <architecture-prefix>');
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
