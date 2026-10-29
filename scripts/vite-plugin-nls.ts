import type { Plugin } from 'vite';
import { collectNlsCalls, collectNlsEntries, moduleId } from './nls-utils.mjs';

interface NlsEntry {
	module: string;
	key: string;
	message: string;
}

export function nlsPlugin(): Plugin {
	const entries: NlsEntry[] = [];
	const dedupIndex = new Map<string, number>();
	let isBuild = false;

	function getOrAddIndex(module: string, key: string, message: string): number {
		const identity = `${module}\0${key}\0${message}`;
		let index = dedupIndex.get(identity);
		if (index === undefined) {
			index = entries.length;
			entries.push({ module, key, message });
			dedupIndex.set(identity, index);
		}
		return index;
	}

	function serializeEntries(): string {
		const modules: string[] = [];
		const moduleIds = new Map<string, number>();
		const messages = entries.map(({ module, key, message }): [number, string, string] => {
			let id = moduleIds.get(module);
			if (id === undefined) {
				id = modules.length;
				modules.push(module);
				moduleIds.set(module, id);
			}
			return [id, key, message];
		});
		return JSON.stringify({ modules, messages });
	}

	return {
		name: 'vite-plugin-nls',
		enforce: 'pre',
		config(_config, environment) {
			isBuild = environment.command === 'build';
		},
		configureServer(server) {
			server.middlewares.use('/nls.messages.json', (_request, response) => {
				response.setHeader('Content-Type', 'application/json');
				response.setHeader('Cache-Control', 'no-store');
				response.end(serializeEntries());
			});
		},
		buildStart() {
			// Vite can reuse a plugin instance for watch/rebuild. Old indices must not leak into a new build.
			entries.length = 0;
			dedupIndex.clear();
			if (!isBuild) {
				for (const entry of collectNlsEntries()) getOrAddIndex(entry.module, entry.key, entry.message);
			}
		},
		transform(code, id) {
			const filename = id.split('?')[0].replace(/\\/g, '/');
			if (!filename.includes('/src/vs/') || !filename.endsWith('.ts') || !code.includes('localize')) return null;
			const calls = collectNlsCalls(code, filename);
			if (calls.length === 0) return null;
			const module = moduleId(filename);
			let output = '';
			let cursor = 0;
			for (const call of calls) {
				output += code.slice(cursor, call.start) + getOrAddIndex(module, call.key, call.message);
				cursor = call.end;
			}
			return { code: output + code.slice(cursor), map: null };
		},
		generateBundle() {
			this.emitFile({ type: 'asset', fileName: 'nls.messages.json', source: serializeEntries() });
		}
	};
}
