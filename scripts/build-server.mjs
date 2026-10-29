import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../sidexai/sidex-server/', import.meta.url));
const filename = process.platform === 'win32' ? 'sidex-server.exe' : 'sidex-server';
const child = spawn('go', ['build', '-tags', 'fts5', '-o', filename, './cmd/server'], {
	cwd: directory,
	env: process.env,
	stdio: 'inherit',
	shell: false
});
child.once('error', error => {
	console.error(`Unable to start Go. Install Go 1.26 or later and a C compiler: ${error.message}`);
	process.exitCode = 1;
});
child.once('close', (code, signal) => {
	process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});
