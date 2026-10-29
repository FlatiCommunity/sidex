/*---------------------------------------------------------------------------------------------
 *  SideX WSL filesystem: native Linux paths, binary content and Linux permissions.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { URI } from '../../../base/common/uri.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import {
	FileChangeType,
	FilePermission,
	FileSystemProviderCapabilities,
	FileSystemProviderErrorCode,
	FileType,
	createFileSystemProviderError,
	IFileChange,
	IFileDeleteOptions,
	IFileOverwriteOptions,
	IFileWriteOptions,
	IStat,
	IWatchOptions,
	IFileSystemProviderWithFileReadWriteCapability
} from '../common/files.js';

export const WSL_SCHEME = 'sidex-wsl';

type Snapshot = Record<string, number[]>;

export class WslFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadWriteCapability {
	readonly capabilities =
		FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;
	private readonly changes = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this.changes.event;
	private readonly watchErrors = this._register(new Emitter<string>());
	readonly onDidWatchError = this.watchErrors.event;

	private async request<T>(resource: URI, op: string, args: Record<string, unknown> = {}): Promise<T> {
		if (resource.scheme !== WSL_SCHEME || !resource.authority || !resource.path.startsWith('/')) {
			throw createFileSystemProviderError('Invalid WSL resource URI', FileSystemProviderErrorCode.Unavailable);
		}
		try {
			return await invoke<T>('wsl_file_request', {
				distro: resource.authority,
				request: { ...args, op, path: resource.path }
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes('WSL_PYTHON_REQUIRED')) {
				throw createFileSystemProviderError(
					localize(
						'wsl.pythonRequired',
						'Python 3 is required in WSL distribution {0}. Install python3 there and reconnect. {1}',
						resource.authority,
						message
					),
					FileSystemProviderErrorCode.Unavailable
				);
			}
			const codes: Record<string, FileSystemProviderErrorCode> = {
				FileNotFound: FileSystemProviderErrorCode.FileNotFound,
				FileExists: FileSystemProviderErrorCode.FileExists,
				FileIsADirectory: FileSystemProviderErrorCode.FileIsADirectory,
				FileNotADirectory: FileSystemProviderErrorCode.FileNotADirectory,
				NoPermissions: FileSystemProviderErrorCode.NoPermissions,
				FileTooLarge: FileSystemProviderErrorCode.FileTooLarge
			};
			throw createFileSystemProviderError(
				message,
				codes[message.split(':', 1)[0]] ?? FileSystemProviderErrorCode.Unavailable
			);
		}
	}

	async stat(resource: URI): Promise<IStat> {
		const result = await this.request<IStat & { readonly: boolean }>(resource, 'stat');
		return { ...result, permissions: result.readonly ? FilePermission.Readonly : undefined };
	}

	readdir(resource: URI): Promise<[string, FileType][]> {
		return this.request(resource, 'readdir');
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		return Uint8Array.from(await this.request<number[]>(resource, 'read'));
	}

	async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions): Promise<void> {
		await this.request(resource, 'write', {
			data: Array.from(content),
			create: options.create,
			overwrite: options.overwrite
		});
		this.changes.fire([{ resource, type: FileChangeType.UPDATED }]);
	}

	async mkdir(resource: URI): Promise<void> {
		await this.request(resource, 'mkdir');
		this.changes.fire([{ resource, type: FileChangeType.ADDED }]);
	}

	async delete(resource: URI, options: IFileDeleteOptions): Promise<void> {
		if (options.useTrash) {
			throw createFileSystemProviderError(
				localize('wsl.noTrash', 'The WSL filesystem does not provide a recycle bin.'),
				FileSystemProviderErrorCode.Unavailable
			);
		}
		await this.request(resource, 'delete', { recursive: options.recursive });
		this.changes.fire([{ resource, type: FileChangeType.DELETED }]);
	}

	async rename(from: URI, to: URI, options: IFileOverwriteOptions): Promise<void> {
		if (to.scheme !== WSL_SCHEME || from.authority !== to.authority) {
			throw createFileSystemProviderError(
				localize('wsl.crossDistroRename', 'Moving files between WSL distributions requires copying them first.'),
				FileSystemProviderErrorCode.Unavailable
			);
		}
		await this.request(from, 'rename', { target: to.path, overwrite: options.overwrite });
		this.changes.fire([
			{ resource: from, type: FileChangeType.DELETED },
			{ resource: to, type: FileChangeType.ADDED }
		]);
	}

	watch(resource: URI, options: IWatchOptions): IDisposable {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let previous: Snapshot | undefined;
		let lastError: string | undefined;
		const poll = async () => {
			try {
				const current = await this.request<Snapshot>(resource, 'snapshot', {
					recursive: options.recursive,
					excludes: options.excludes
				});
				if (!stopped && previous) {
					const changes: IFileChange[] = [];
					for (const [path, signature] of Object.entries(current)) {
						const old = previous[path];
						if (!old || old.join(',') !== signature.join(',')) {
							changes.push({
								resource: resource.with({ path }),
								type: old ? FileChangeType.UPDATED : FileChangeType.ADDED
							});
						}
					}
					for (const path of Object.keys(previous)) {
						if (!(path in current)) {
							changes.push({ resource: resource.with({ path }), type: FileChangeType.DELETED });
						}
					}
					if (changes.length) {
						this.changes.fire(changes);
					}
				}
				previous = current;
				lastError = undefined;
			} catch (error) {
				const message = String(error);
				if (!stopped && message !== lastError) {
					this.watchErrors.fire(message);
					lastError = message;
				}
			} finally {
				if (!stopped) {
					timer = setTimeout(poll, 2000);
				}
			}
		};
		void poll();
		return this._register(
			toDisposable(() => {
				stopped = true;
				if (timer) {
					clearTimeout(timer);
				}
			})
		);
	}
}
