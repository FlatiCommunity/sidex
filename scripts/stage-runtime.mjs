import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);

export function targetPlatform(target) {
	const platform = target.includes('-windows-')
		? 'win32'
		: target.endsWith('-apple-darwin')
			? 'darwin'
			: target.includes('-linux-')
				? 'linux'
				: undefined;
	const architecture = target.split('-')[0];
	const arch = { x86_64: 'x64', aarch64: 'arm64', i686: 'ia32', armv7: 'arm', riscv64gc: 'riscv64' }[architecture];
	if (platform === 'darwin' && architecture === 'universal') return { platform, architectures: ['x64', 'arm64'] };
	if (!platform || !arch) throw new Error(`Unsupported release target: ${target}`);
	return { platform, architectures: [arch] };
}

/** Inspect executable headers without executing a binary intended for another OS or architecture. */
export function binaryPlatform(header) {
	if (header.length < 64) throw new Error('Executable header is too short');
	if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
		const machine = header[5] === 2 ? header.readUInt16BE(18) : header.readUInt16LE(18);
		const architecture = { 3: 'ia32', 40: 'arm', 62: 'x64', 183: 'arm64', 243: 'riscv64' }[machine];
		if (architecture) return { platform: 'linux', architectures: [architecture] };
	}
	if (header.readUInt16LE(0) === 0x5a4d) {
		const pe = header.readUInt32LE(60);
		if (pe + 6 <= header.length && header.readUInt32LE(pe) === 0x00004550) {
			const architecture = { 0x014c: 'ia32', 0x8664: 'x64', 0xaa64: 'arm64' }[header.readUInt16LE(pe + 4)];
			if (architecture) return { platform: 'win32', architectures: [architecture] };
		}
	}
	const machoArchitecture = cpu => ({ 7: 'ia32', 0x01000007: 'x64', 12: 'arm', 0x0100000c: 'arm64' })[cpu];
	for (const endian of ['BE', 'LE']) {
		const read = offset => header[`readUInt32${endian}`](offset);
		const magic = read(0);
		if (magic === 0xfeedface || magic === 0xfeedfacf) {
			const architecture = machoArchitecture(read(4));
			if (architecture) return { platform: 'darwin', architectures: [architecture] };
		}
		if (magic === 0xcafebabe || magic === 0xcafebabf) {
			const count = read(4);
			const size = magic === 0xcafebabf ? 32 : 20;
			if (count > 0 && count <= 32 && 8 + count * size <= header.length) {
				const architectures = Array.from({ length: count }, (_, index) =>
					machoArchitecture(read(8 + index * size))
				).filter(Boolean);
				if (architectures.length) return { platform: 'darwin', architectures: [...new Set(architectures)] };
			}
		}
	}
	throw new Error('Unrecognized executable format or architecture');
}

async function inspectBinary(filename) {
	const handle = await fs.open(filename);
	try {
		const header = Buffer.alloc(65536);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		return binaryPlatform(header.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}
}

export function assertTarget(actual, expected, filename) {
	if (
		actual.platform !== expected.platform ||
		expected.architectures.some(arch => !actual.architectures.includes(arch))
	) {
		throw new Error(
			`${filename} is ${actual.platform}/${actual.architectures.join('+')}; the release requires ${expected.platform}/${expected.architectures.join('+')}. Supply a matching --node or --server binary.`
		);
	}
}

async function sha256(filename) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	return hash.digest('hex');
}

async function nodeLicense(binary, explicitLicense) {
	const directory = path.dirname(binary);
	const candidates = explicitLicense
		? [explicitLicense]
		: [
				path.join(directory, 'LICENSE'),
				path.join(directory, '../LICENSE'),
				path.join(directory, '../share/doc/node/LICENSE'),
				path.join(directory, '../share/doc/nodejs/LICENSE')
			];
	for (const candidate of candidates) {
		try {
			const text = await fs.readFile(candidate, 'utf8');
			if (text.includes('Node.js') && text.includes('Permission is hereby granted')) return text;
		} catch {
			/* Try the next standard Node distribution location. */
		}
	}
	throw new Error(
		`The complete Node.js LICENSE was not found beside ${binary}. Pass --node-license with LICENSE from that Node distribution.`
	);
}

function currentTarget() {
	const arch = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686', arm: 'armv7', riscv64: 'riscv64gc' }[process.arch];
	const suffix = { darwin: 'apple-darwin', win32: 'pc-windows-msvc', linux: 'unknown-linux-gnu' }[process.platform];
	if (!arch || !suffix) throw new Error('Specify --target for this platform');
	return `${arch}-${suffix}`;
}

export async function stageRuntime(options = {}) {
	const target = options.target ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? currentTarget();
	const expected = targetPlatform(target);
	const output = path.resolve(options.output ?? path.join(root, 'src-tauri/runtime'));
	const nodes =
		expected.architectures.length === 2 && (options.nodeX64 || options.nodeArm64)
			? expected.architectures.map(arch => ({
					file: options[arch === 'x64' ? 'nodeX64' : 'nodeArm64'],
					arch,
					directory: `node-${arch}`
				}))
			: [{ file: options.node ?? process.env.SIDEX_NODE_BINARY ?? process.execPath, directory: 'node' }];
	if (nodes.some(node => !node.file))
		throw new Error(
			'A universal macOS release needs both --node-x64 and --node-arm64, or one universal --node binary.'
		);
	if (options.server && options.buildServer) throw new Error('Choose either --server or --build-server');

	// Validate every input before replacing an existing staged runtime.
	for (const node of nodes) {
		node.file = path.resolve(node.file);
		node.binary = await inspectBinary(node.file);
		assertTarget(
			node.binary,
			{ platform: expected.platform, architectures: node.arch ? [node.arch] : expected.architectures },
			node.file
		);
		node.license = await nodeLicense(node.file, options.nodeLicense ?? process.env.SIDEX_NODE_LICENSE);
		if (node.binary.platform === process.platform && node.binary.architectures.includes(process.arch)) {
			node.version =
				node.file === process.execPath
					? process.version
					: (await execute(node.file, ['--version'], { encoding: 'utf8', timeout: 10000 })).stdout.trim();
			if (!/^v(?:[2-9]\d|1[89]|\d{3,})\.\d+\.\d+/.test(node.version))
				throw new Error(`${node.file} is not a supported Node.js executable (requires Node.js 18 or later).`);
		}
	}
	const server = options.server ?? process.env.SIDEX_SERVER_BIN;
	if (server) assertTarget(await inspectBinary(server), expected, server);
	await fs.mkdir(output, { recursive: true });
	const temporary = await fs.mkdtemp(path.join(output, '.stage-'));
	const files = [];
	try {
		for (const node of nodes) {
			const relative = `${node.directory}/${expected.platform === 'win32' ? 'node.exe' : 'bin/node'}`;
			const destination = path.join(temporary, relative);
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await fs.copyFile(node.file, destination);
			await fs.chmod(destination, 0o755);
			await fs.writeFile(path.join(temporary, node.directory, 'LICENSE'), node.license);
			files.push({
				kind: 'node',
				path: relative,
				version: node.version,
				...node.binary,
				sha256: await sha256(destination),
				license: `${node.directory}/LICENSE`
			});
		}
		if (server || options.buildServer) {
			const relative = `server/sidex-server${expected.platform === 'win32' ? '.exe' : ''}`;
			const destination = path.join(temporary, relative);
			await fs.mkdir(path.dirname(destination), { recursive: true });
			if (server) await fs.copyFile(server, destination);
			else {
				if (
					expected.platform !== process.platform ||
					expected.architectures.length !== 1 ||
					expected.architectures[0] !== process.arch
				) {
					throw new Error(
						'Building the Go server requires a native target with a C compiler. Cross-build it separately and use --server.'
					);
				}
				await new Promise((resolve, reject) => {
					const child = spawn('go', ['build', '-trimpath', '-tags', 'fts5', '-o', destination, './cmd/server'], {
						cwd: path.join(root, 'sidexai/sidex-server'),
						stdio: 'inherit',
						env: { ...process.env, CGO_ENABLED: '1' }
					});
					child.once('error', reject);
					child.once('close', code =>
						code === 0 ? resolve() : reject(new Error(`Go server build failed with exit code ${code}`))
					);
				});
			}
			const binary = await inspectBinary(destination);
			assertTarget(binary, expected, destination);
			await fs.chmod(destination, 0o755);
			files.push({ kind: 'server', path: relative, ...binary, sha256: await sha256(destination) });
		}
		await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify({ target, files }, null, 2) + '\n');
		for (const generated of ['node', 'node-x64', 'node-arm64', 'server', 'manifest.json']) {
			await fs.rm(path.join(output, generated), { recursive: true, force: true });
		}
		for (const generated of await fs.readdir(temporary))
			await fs.rename(path.join(temporary, generated), path.join(output, generated));
		return { target, files, output };
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = {};
		const names = {
			'--target': 'target',
			'--node': 'node',
			'--node-x64': 'nodeX64',
			'--node-arm64': 'nodeArm64',
			'--node-license': 'nodeLicense',
			'--server': 'server',
			'--output': 'output'
		};
		for (let index = 2; index < process.argv.length; index++) {
			const flag = process.argv[index];
			if (flag === '--build-server') options.buildServer = true;
			else if (names[flag] && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'))
				options[names[flag]] = process.argv[++index];
			else throw new Error(`Unknown or incomplete option: ${flag}`);
		}
		const result = await stageRuntime(options);
		console.log(`Staged ${result.files.length} runtime executable(s) for ${result.target} in ${result.output}`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
