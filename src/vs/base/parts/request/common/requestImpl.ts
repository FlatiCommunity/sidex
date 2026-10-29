/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { bufferToStream, VSBuffer } from '../../../common/buffer.js';
import { CancellationToken } from '../../../common/cancellation.js';
import { canceled } from '../../../common/errors.js';
import { IHeaders, IRequestContext, IRequestOptions, OfflineError } from './request.js';

export async function request(
	options: IRequestOptions,
	token: CancellationToken,
	isOnline?: () => boolean
): Promise<IRequestContext> {
	if (token.isCancellationRequested) {
		throw canceled();
	}

	const cancellation = new AbortController();
	const disposable = token.onCancellationRequested(() => cancellation.abort());
	// WKWebView on supported macOS versions does not implement AbortSignal.any
	// or AbortSignal.timeout. One controller also lets us release the timeout
	// as soon as the response body has finished, rather than retaining it.
	let timedOut = false;
	const timeout =
		options.timeout && options.timeout > 0
			? setTimeout(() => {
					timedOut = true;
					cancellation.abort();
				}, options.timeout)
			: undefined;

	try {
		const fetchInit: RequestInit = {
			method: options.type || 'GET',
			headers: getRequestHeaders(options),
			body: options.data,
			signal: cancellation.signal
		};
		if (options.disableCache) {
			fetchInit.cache = 'no-store';
		}
		const res = await fetch(options.url || '', fetchInit);
		return {
			res: {
				statusCode: res.status,
				headers: getResponseHeaders(res)
			},
			stream: bufferToStream(VSBuffer.wrap(new Uint8Array(await res.arrayBuffer())))
		};
	} catch (err) {
		if (token.isCancellationRequested) {
			throw canceled();
		}
		if (timedOut || err?.name === 'TimeoutError') {
			throw new Error(`Fetch timeout: ${options.timeout}ms`);
		}
		if (isOnline && !isOnline()) {
			throw new OfflineError();
		}
		if (err?.name === 'AbortError') {
			throw canceled();
		}
		throw err;
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		disposable.dispose();
	}
}

function getRequestHeaders(options: IRequestOptions) {
	if (options.headers || options.user || options.password || options.proxyAuthorization) {
		const headers = new Headers();
		outer: for (const k in options.headers) {
			switch (k.toLowerCase()) {
				case 'user-agent':
				case 'accept-encoding':
				case 'content-length':
					// unsafe headers
					continue outer;
			}
			const header = options.headers[k];
			if (typeof header === 'string') {
				headers.set(k, header);
			} else if (Array.isArray(header)) {
				for (const h of header) {
					headers.append(k, h);
				}
			}
		}
		if (options.user || options.password) {
			headers.set('Authorization', 'Basic ' + btoa(`${options.user || ''}:${options.password || ''}`));
		}
		if (options.proxyAuthorization) {
			headers.set('Proxy-Authorization', options.proxyAuthorization);
		}
		return headers;
	}
	return undefined;
}

function getResponseHeaders(res: Response): IHeaders {
	const headers: IHeaders = Object.create(null);
	res.headers.forEach((value, key) => {
		if (headers[key]) {
			if (Array.isArray(headers[key])) {
				headers[key].push(value);
			} else {
				headers[key] = [headers[key], value];
			}
		} else {
			headers[key] = value;
		}
	});
	return headers;
}
