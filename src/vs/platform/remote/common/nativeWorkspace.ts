/*---------------------------------------------------------------------------------------------
 *  Identity of a native virtual workspace. Never convert these paths to local fsPath.
 *--------------------------------------------------------------------------------------------*/

export interface NativeWorkspace {
	scheme: string;
	authority: string;
	path: string;
}

export function getNativeWorkspace(): NativeWorkspace | undefined {
	return (globalThis as { __SIDEX_WORKSPACE__?: NativeWorkspace }).__SIDEX_WORKSPACE__;
}

export function hasNonLocalWorkspace(): boolean {
	const workspace = getNativeWorkspace();
	return !!workspace && workspace.scheme !== 'file';
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
