/*---------------------------------------------------------------------------------------------
 *  Native SSH connection and workspace selection.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISideXRemoteService, SshAuth, SshHost } from '../../../../platform/sidex/browser/sidexRemoteService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { SSH_SCHEME } from '../../../../platform/files/browser/tauriSshFileSystemProvider.js';
import { parseSshTarget } from '../../../../platform/remote/common/sshTarget.js';

export async function connectSshWorkspace(
	target: SshHost | undefined,
	quickInput: IQuickInputService,
	remote: ISideXRemoteService,
	hostService: IHostService
): Promise<void> {
	let host: string;
	let user: string | undefined;
	let port: number;
	if (target) {
		if (target.proxyJump)
			throw new Error(
				localize(
					'ssh.proxyJumpUnsupported',
					'This SSH target uses ProxyJump. Connect to the destination through your SSH tunnel or use a directly reachable host.'
				)
			);
		host = target.hostname || target.host;
		user = target.user || undefined;
		port = target.port ?? 22;
	} else {
		const input = await quickInput.input({
			prompt: localize('ssh.destination', 'SSH destination (user@hostname:port or user@[IPv6]:port)'),
			placeHolder: 'user@example.com:22',
			validateInput: async value => {
				try {
					parseSshTarget(value);
					return undefined;
				} catch {
					return localize('ssh.invalidDestination', 'Enter a hostname and a port between 1 and 65535.');
				}
			}
		});
		if (input === undefined) return;
		({ host, user, port } = parseSshTarget(input));
	}
	if (!user) {
		user = await quickInput.input({
			prompt: localize('ssh.username', 'SSH username'),
			validateInput: async value =>
				value.trim() && !/[\s\x00-\x1f\x7f]/.test(value)
					? undefined
					: localize('ssh.usernameRequired', 'Enter an SSH username.')
		});
		if (!user) return;
	}

	const key = await invoke<{ status: 'trusted' | 'unknown' | 'changed'; fingerprint: string }>(
		'remote_ssh_probe_host',
		{ host, port }
	);
	if (key.status === 'changed')
		throw new Error(
			localize(
				'ssh.hostKeyChanged',
				'The host key for {0}:{1} has changed ({2}). Verify the new key with the server administrator before updating known_hosts.',
				host,
				port,
				key.fingerprint
			)
		);
	let trustedFingerprint: string | undefined;
	if (key.status === 'unknown') {
		const trust = await quickInput.pick(
			[
				{ label: localize('ssh.cancel', 'Cancel'), trust: false },
				{ label: localize('ssh.trustHost', 'Trust this host key and connect'), detail: key.fingerprint, trust: true }
			],
			{
				placeHolder: localize(
					'ssh.verifyHost',
					'Verify the SSH fingerprint for {0}:{1}: {2}',
					host,
					port,
					key.fingerprint
				)
			}
		);
		if (!trust?.trust) return;
		trustedFingerprint = key.fingerprint;
	}

	const methods = [
		{ label: localize('ssh.authAgent', 'SSH agent'), kind: 'agent' },
		{ label: localize('ssh.authKey', 'Private key file'), description: target?.identityFile ?? '', kind: 'keyfile' },
		{ label: localize('ssh.authPassword', 'Password'), kind: 'password' }
	];
	if (target?.identityFile) methods.unshift(...methods.splice(1, 1));
	const method = await quickInput.pick(methods, {
		placeHolder: localize('ssh.authMethod', 'Choose SSH authentication')
	});
	if (!method) return;
	let auth: SshAuth;
	if (method.kind === 'password') {
		const password = await quickInput.input({
			prompt: localize('ssh.passwordPrompt', 'Password for {0}@{1}', user, host),
			password: true
		});
		if (password === undefined) return;
		auth = { kind: 'password', password };
	} else if (method.kind === 'keyfile') {
		const path = await quickInput.input({
			prompt: localize('ssh.keyPath', 'Path to your local SSH private key'),
			value: target?.identityFile ?? ''
		});
		if (!path) return;
		const passphrase = await quickInput.input({
			prompt: localize('ssh.keyPassphrase', 'Private key passphrase (leave empty for an unencrypted key)'),
			password: true
		});
		if (passphrase === undefined) return;
		auth = { kind: 'keyfile', path, passphrase: passphrase || undefined };
	} else {
		auth = { kind: 'agent' };
	}

	const connection = await remote.connectSsh(host, user, port, auth, trustedFingerprint);
	try {
		const home = await invoke<string>('remote_ssh_file_request', {
			authority: connection.label,
			request: { op: 'home' }
		});
		const path = await quickInput.input({
			prompt: localize('ssh.folderPrompt', 'Remote folder to open on {0}', connection.label),
			value: home,
			validateInput: async value =>
				value.startsWith('/') ? undefined : localize('ssh.absoluteFolder', 'Enter an absolute remote folder path.')
		});
		if (!path) {
			await remote.disconnect(connection.id);
			return;
		}
		const info = await invoke<{ type: number }>('remote_ssh_file_request', {
			authority: connection.label,
			request: { op: 'stat', path }
		});
		if ((info.type & 2) === 0)
			throw new Error(localize('ssh.folderRequired', 'The selected remote path is not a folder.'));
		await hostService.openWindow([{ folderUri: URI.from({ scheme: SSH_SCHEME, authority: connection.label, path }) }], {
			forceNewWindow: true
		});
	} catch (error) {
		await remote.disconnect(connection.id).catch(() => {});
		throw error;
	}
}
