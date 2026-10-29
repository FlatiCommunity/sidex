/*---------------------------------------------------------------------------------------------
 *  Identity of a native virtual workspace. Never convert these paths to local fsPath.
 *--------------------------------------------------------------------------------------------*/

export interface NativeWorkspace {
	scheme: string;
	authority: string;
	path: string;
}

interface NativeWorkspaceGlobals {
	__SIDEX_WORKSPACE__?: NativeWorkspace;
	__SIDEX_WORKSPACE_FOLDERS__?: readonly NativeWorkspace[];
}

/** The opened .code-workspace file can itself be local while its folders are remote. */
export function setNativeWorkspaceFolders(folders: readonly NativeWorkspace[]): void {
	(globalThis as NativeWorkspaceGlobals).__SIDEX_WORKSPACE_FOLDERS__ = folders.map(({ scheme, authority, path }) => ({
		scheme,
		authority,
		path
	}));
}

export function getNativeWorkspace(): NativeWorkspace | undefined {
	const state = globalThis as NativeWorkspaceGlobals;
	return state.__SIDEX_WORKSPACE_FOLDERS__ === undefined
		? state.__SIDEX_WORKSPACE__
		: state.__SIDEX_WORKSPACE_FOLDERS__[0];
}

export function hasNonLocalWorkspace(): boolean {
	const state = globalThis as NativeWorkspaceGlobals;
	if (state.__SIDEX_WORKSPACE_FOLDERS__ !== undefined) {
		return state.__SIDEX_WORKSPACE_FOLDERS__.some(folder => folder.scheme !== 'file');
	}
	return !!state.__SIDEX_WORKSPACE__ && state.__SIDEX_WORKSPACE__.scheme !== 'file';
}

/** Native terminals use argument arrays so spaces and shell syntax stay literal. */
export function wslTerminalLaunch(
	workspace: NativeWorkspace,
	cwd?: string
): { executable: string; args: string[]; cwd: string } {
	const linuxCwd = cwd?.startsWith('/') ? cwd : workspace.path;
	return {
		executable: 'wsl.exe',
		args: ['--distribution', workspace.authority, '--cd', linuxCwd],
		cwd: linuxCwd
	};
}
