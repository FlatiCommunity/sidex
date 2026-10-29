/*---------------------------------------------------------------------------------------------
 *  SideX — Low-level Tauri IPC bridge.
 *  Wraps `window.__TAURI__` with a graceful fallback when running outside
 *  the Tauri webview (e.g. in a plain browser during development).
 *--------------------------------------------------------------------------------------------*/

declare global {
	interface Window {
		__TAURI_INTERNALS__?: {
			invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
		};
		__TAURI_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
		__TAURI__?: {
			core: {
				invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			};
		};
	}
}

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

function getInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
	if (_invoke) {
		return _invoke;
	}
	if (typeof window === 'undefined') {
		return null;
	}
	if (window.__TAURI_INTERNALS__?.invoke) {
		_invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
		return _invoke;
	}
	if (window.__TAURI_INVOKE__) {
		_invoke = window.__TAURI_INVOKE__;
		return _invoke;
	}
	if (window.__TAURI__?.core?.invoke) {
		_invoke = window.__TAURI__.core.invoke;
		return _invoke;
	}
	return null;
}

export async function invoke<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
	const fn = getInvoke();
	if (!fn) {
		throw new Error(`[SideX] Cannot invoke ${cmd}: the native Tauri runtime is unavailable`);
	}
	return fn(cmd, args) as Promise<T>;
}

export function isTauri(): boolean {
	return !!getInvoke();
}
