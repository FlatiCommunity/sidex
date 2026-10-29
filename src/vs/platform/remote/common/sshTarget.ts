/*---------------------------------------------------------------------------------------------
 *  Parse SSH destinations without confusing IPv6 colons with port separators.
 *--------------------------------------------------------------------------------------------*/

export interface SshTarget {
	host: string;
	user?: string;
	port: number;
}

export function parseSshTarget(input: string): SshTarget {
	const value = input.trim();
	if (!value || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid SSH destination');
	const url = new URL(`ssh://${value}`);
	if (!url.hostname || url.password || url.pathname || url.search || url.hash)
		throw new Error('Invalid SSH destination');
	const port = url.port ? Number(url.port) : 22;
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be between 1 and 65535');
	const user = url.username ? decodeURIComponent(url.username) : undefined;
	if (user && /[\s\x00-\x1f\x7f]/.test(user)) throw new Error('Invalid SSH user');
	return { host: url.hostname.replace(/^\[|\]$/g, ''), user, port };
}
