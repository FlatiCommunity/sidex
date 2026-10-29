import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The xattr compatibility shim is macOS-only. Other systems keep their native PATH syntax. */
export function tauriEnvironment(environment, platform, shimDirectory) {
	const result = { ...environment };
	if (platform === 'darwin') {
		result.PATH = [shimDirectory, environment.PATH].filter(Boolean).join(':');
	}
	return result;
}

export function launchTauri(args, options = {}) {
	const require = createRequire(import.meta.url);
	const child = spawn(
		options.runtime ?? process.execPath,
		[options.cli ?? require.resolve('@tauri-apps/cli/tauri.js'), ...args],
		{
			cwd: options.cwd ?? root,
			env: tauriEnvironment(
				options.env ?? process.env,
				options.platform ?? process.platform,
				path.join(root, 'scripts/bin')
			),
			stdio: 'inherit',
			shell: false
		}
	);
	return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const child = launchTauri(process.argv.slice(2));
		const forwardInterrupt = () => child.kill('SIGINT');
		const forwardTerminate = () => child.kill('SIGTERM');
		process.once('SIGINT', forwardInterrupt);
		process.once('SIGTERM', forwardTerminate);
		child.once('error', error => {
			console.error(`Unable to start the Tauri CLI: ${error.message}`);
			process.exitCode = 1;
		});
		child.once('close', (code, signal) => {
			process.removeListener('SIGINT', forwardInterrupt);
			process.removeListener('SIGTERM', forwardTerminate);
			process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
		});
	} catch (error) {
		console.error(`Unable to locate the Tauri CLI. Install frontend dependencies first. ${error.message}`);
		process.exitCode = 1;
	}
}
