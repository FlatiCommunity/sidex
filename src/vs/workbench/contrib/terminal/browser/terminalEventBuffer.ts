/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface NativeTerminalEvent {
	terminal_id: number;
	client_id?: string;
}

/** A shell may print and exit before the spawn IPC response reaches the webview. */
export class TerminalEventBuffer {
	private backendId: number | undefined;
	private ready = false;
	private stopped = false;
	private readonly pending: Array<{ data: string } | { exitCode: number }> = [];

	constructor(
		readonly clientId: string,
		private readonly onData: (data: string) => void,
		private readonly onExit: (code: number) => void
	) {}

	private belongsToTerminal(event: NativeTerminalEvent): boolean {
		return (
			!this.stopped &&
			(event.client_id === this.clientId ||
				(event.client_id === undefined && this.backendId !== undefined && event.terminal_id === this.backendId))
		);
	}

	data(event: NativeTerminalEvent & { data: string }): void {
		if (!this.belongsToTerminal(event)) {
			return;
		}
		if (this.ready) {
			this.onData(event.data);
		} else {
			this.pending.push({ data: event.data });
		}
	}

	exit(event: NativeTerminalEvent & { exit_code: number }): void {
		if (!this.belongsToTerminal(event)) {
			return;
		}
		if (this.ready) {
			this.onExit(event.exit_code);
		} else {
			this.pending.push({ exitCode: event.exit_code });
		}
	}

	/** Call only after onProcessReady so xterm has a consumer for the first prompt. */
	attach(backendId: number): void {
		if (this.stopped) {
			return;
		}
		this.backendId = backendId;
		this.ready = true;
		for (const event of this.pending.splice(0)) {
			if ('data' in event) {
				this.onData(event.data);
			} else {
				this.onExit(event.exitCode);
			}
		}
	}

	dispose(): void {
		this.stopped = true;
		this.pending.length = 0;
	}
}
