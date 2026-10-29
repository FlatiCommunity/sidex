/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MarkedExtension, Token, TokensList } from '../../../../base/common/marked/marked.js';

/** Map top-level blocks to their actual source positions, without counting nested tokens twice. */
export function sourceLineMarkers(source: string): MarkedExtension {
	const normalized = source.replace(/\r\n?/g, '\n');
	return {
		hooks: {
			processAllTokens(tokens: Token[] | TokensList): Token[] | TokensList {
				const mapped = [] as unknown as TokensList;
				mapped.links = (tokens as TokensList).links;
				let offset = 0;
				let line = 1;
				for (const token of tokens) {
					// Definitions need not produce a token. Locate raw source instead of assuming
					// that concatenating token.raw reconstructs the original document.
					const found = normalized.indexOf(token.raw, offset);
					if (found >= offset) {
						line += (normalized.slice(offset, found).match(/\n/g) || []).length;
						offset = found;
					}
					if (token.type !== 'space' && token.type !== 'def') {
						mapped.push({
							type: 'html',
							raw: '',
							block: true,
							text: `<span class="sidex-source-line" data-source-line="${line}" aria-hidden="true"></span>`
						});
					}
					mapped.push(token);
					line += (token.raw.match(/\n/g) || []).length;
					offset += token.raw.length;
				}
				const lastLine = normalized.split('\n').length;
				mapped.push({
					type: 'html',
					raw: '',
					block: true,
					text: `<span class="sidex-source-line" data-source-line="${lastLine}" aria-hidden="true"></span>`
				});
				return mapped;
			}
		}
	};
}

// Only this nonce-protected script runs in previews; markdown itself is sanitized.
export const markdownPreviewScript = `(() => {
	const api = acquireVsCodeApi();
	let ignoreScrollUntil = 0;
	let pendingScroll = false;
	const points = () => Array.from(document.querySelectorAll('.sidex-source-line')).map(node => ({
		line: Number(node.getAttribute('data-source-line')),
		top: (node.nextElementSibling || node).getBoundingClientRect().top + window.scrollY
	})).filter(point => Number.isFinite(point.line));
	const lineAt = (top) => {
		const list = points();
		if (!list.length) { return 1; }
		let before = list[0];
		for (const after of list.slice(1)) {
			if (after.top > top) {
				const fraction = Math.max(0, Math.min(1, (top - before.top) / Math.max(1, after.top - before.top)));
				return before.line + fraction * (after.line - before.line);
			}
			before = after;
		}
		return before.line;
	};
	window.addEventListener('message', event => {
		const message = event.data;
		if (!message || message.type !== 'sidex.markdown.line' || !Number.isFinite(message.line)) { return; }
		const list = points();
		if (!list.length) { return; }
		let before = list[0];
		let top = before.top;
		for (const after of list.slice(1)) {
			if (after.line > message.line) {
				top = before.top + Math.max(0, (message.line - before.line) / Math.max(1, after.line - before.line)) * (after.top - before.top);
				break;
			}
			before = after;
			top = before.top;
		}
		ignoreScrollUntil = performance.now() + 150;
		window.scrollTo(0, Math.max(0, top));
	});
	window.addEventListener('scroll', () => {
		if (pendingScroll || performance.now() < ignoreScrollUntil) { return; }
		pendingScroll = true;
		requestAnimationFrame(() => {
			pendingScroll = false;
			if (performance.now() >= ignoreScrollUntil) {
				api.postMessage({ type: 'sidex.markdown.scroll', line: lineAt(window.scrollY) });
			}
		});
	}, { passive: true });
	document.addEventListener('dblclick', event => {
		if (event.target.closest('a')) { return; }
		api.postMessage({ type: 'sidex.markdown.reveal', line: lineAt(event.clientY + window.scrollY) });
	});
	api.postMessage({ type: 'sidex.markdown.ready' });
})();`;
