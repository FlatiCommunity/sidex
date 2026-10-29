import { URI } from '../../../../base/common/uri.js';
import { relativePath } from '../../../../base/common/resources.js';

export const GIT_ORIGINAL_SCHEME = 'git-original';

export function gitOriginalUri(resource: URI, root: URI, ref = 'HEAD'): URI {
	return resource.with({ scheme: GIT_ORIGINAL_SCHEME, query: JSON.stringify({ root: root.toString(), ref }) });
}

export function gitOriginalRequest(resource: URI, defaultRoot: URI): { path: string; file: string; reference: string } {
	if (resource.query.startsWith('{')) {
		const data: unknown = JSON.parse(resource.query);
		if (
			!data ||
			typeof data !== 'object' ||
			!('root' in data) ||
			typeof data.root !== 'string' ||
			!('ref' in data) ||
			typeof data.ref !== 'string'
		) {
			throw new Error('Invalid Git resource');
		}
		const root = URI.parse(data.root);
		const file = relativePath(root, resource.with({ scheme: root.scheme, query: '', fragment: '' }));
		if (root.scheme !== 'file' || !file || file === '..' || file.startsWith('../'))
			throw new Error('Git resource is outside its repository');
		return { path: root.fsPath, file, reference: data.ref };
	}
	// Previously persisted editor tabs used repository-relative paths and a plain ref.
	return { path: defaultRoot.fsPath, file: resource.path.replace(/^\//, ''), reference: resource.query || 'HEAD' };
}
