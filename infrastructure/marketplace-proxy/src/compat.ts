import type { NormalizedExtension } from './types';

/**
 * Shape the merged results back into something that looks like
 * Open VSX's `/api/-/search` response. This exists so the existing
 * `sidex-extensions` Rust client (which parses Open VSX JSON) can
 * point at this Worker without any code changes.
 *
 * Field names are a deliberate subset of what Open VSX actually
 * returns — enough for `OpenVsxSearchResponse` + `MarketplaceExtension`
 * in `crates/sidex-extensions/src/marketplace.rs` to deserialize.
 */
export interface OpenVsxCompatItem {
	url: string;
	files: { download: string; icon?: string };
	name: string;
	namespace: string;
	version: string;
	displayName: string;
	description: string;
	averageRating: number;
	downloadCount: number;
	timestamp: string;
}

export interface OpenVsxCompatResponse {
	offset: number;
	totalSize: number;
	extensions: OpenVsxCompatItem[];
}

export function toOpenVsxCompat(items: NormalizedExtension[], offset: number, total = items.length): OpenVsxCompatResponse {
	return {
		offset,
		totalSize: total,
		extensions: items.map(ext => ({
			url: ext.downloadUrl,
			files: {
				download: ext.downloadUrl,
				icon: ext.iconUrl
			},
			name: ext.name,
			namespace: ext.publisher,
			version: ext.version,
			displayName: ext.displayName,
			description: ext.description,
			averageRating: ext.rating,
			downloadCount: ext.installCount,
			timestamp: new Date().toISOString()
		}))
	};
}
