import type { MsExtension } from './ms';

/**
 * Normalized extension shape returned to SideX. Both MS Marketplace
 * and Open VSX responses are flattened into this structure so the
 * client only has to know about one format.
 */
export interface NormalizedExtension {
	id: string;
	name: string;
	displayName: string;
	description: string;
	version: string;
	publisher: string;
	installCount: number;
	rating: number;
	iconUrl?: string;
	downloadUrl: string;
	source: 'microsoft' | 'openvsx';
	targetPlatform?: string;
	/** Complete Microsoft metadata, including all native versions and engine requirements. */
	galleryExtension?: MsExtension;
	/** ISO date string for the version release, used for "Published X ago" display. */
	lastUpdated?: string;
	/** Extension categories e.g. ["Programming Languages", "Linters"] */
	categories?: string[];
	/** Extension tags */
	tags?: string[];
	/** Number of ratings */
	ratingCount?: number;
	/** Repository URL (shown in Resources section) */
	repositoryUrl?: string;
	/**
	 * For Open VSX platform-specific extensions the real file base URL
	 * differs from the generic `/vscode/asset/` path. We store the
	 * base extracted from the download URL so `handleAsset` can
	 * construct per-file URLs correctly.
	 *
	 * Example: `https://open-vsx.org/api/MatteoBigoi/bacon-ls-vscode/alpine-x64/0.27.0/file`
	 */
	openVsxFileBase?: string;
}

export interface NormalizedSearchResponse {
	results: NormalizedExtension[];
	totalCount: number;
	sources: {
		microsoft: { ok: boolean; count: number };
		openvsx: { ok: boolean; count: number };
	};
}

/**
 * Hop-by-hop headers that must not be forwarded. List taken from
 * RFC 7230 §6.1 plus a couple of Cloudflare-specific headers that
 * would leak infrastructure details if we didn't strip them.
 */
export const HOP_BY_HOP = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host',
	'cf-connecting-ip',
	'cf-ipcountry',
	'cf-ray',
	'cf-visitor'
];

export function stripHopByHop(headers: Headers): Headers {
	const out = new Headers(headers);
	for (const h of HOP_BY_HOP) {
		out.delete(h);
	}
	return out;
}

export function withHeaders(response: Response, extra: Record<string, string>): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(extra)) {
		headers.set(key, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
