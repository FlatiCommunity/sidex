/** VS Code gallery protocol adapter for Microsoft Marketplace and Open VSX. */
import { normalizeMsExtension, type MsExtension } from './ms';
import { mergeResults } from './merge';
import type { NormalizedExtension } from './types';

type Source = NormalizedExtension['source'];
interface GalleryQueryBody {
	filters?: { pageSize?: number; criteria?: { filterType: number; value?: string }[] }[];
	flags?: number;
}
interface GalleryResponse {
	results?: {
		extensions?: MsExtension[];
		resultMetadata?: { metadataType: string; metadataItems: { name: string; count: number }[] }[];
	}[];
}

const GALLERIES: Record<Source, string> = {
	microsoft: 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
	openvsx: 'https://open-vsx.org/vscode/gallery/extensionquery'
};

/**
 * Both registries implement the gallery protocol. Forward the complete query
 * (including names, UUIDs, versions, flags and pagination) and retain their
 * complete response metadata. Rebuilding this from Open VSX search results
 * loses native variants, engine constraints, real UUIDs and optional assets.
 */
export async function handleGalleryQuery(request: Request, origin: string): Promise<{ body: string; total: number }> {
	const queryBody = await request.json() as GalleryQueryBody;
	if (!Array.isArray(queryBody?.filters)) throw new Error('invalid gallery query body');
	const pageSize = Math.max(1, Math.min(Math.trunc(queryBody.filters[0]?.pageSize ?? 50), 100));
	const platform = new URL(request.url).searchParams.get('targetPlatform');
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	let responses: PromiseSettledResult<{ items: NormalizedExtension[]; total: number }>[];
	try {
		responses = await Promise.allSettled((['microsoft', 'openvsx'] as const).map(source =>
			fetchGallery(source, queryBody, platform, controller.signal)));
	} finally {
		clearTimeout(timeout);
	}
	if (responses.every(result => result.status === 'rejected')) throw new Error('all extension registries are unavailable');
	const [ms, ovsx] = responses.map(result => result.status === 'fulfilled' ? result.value : { items: [], total: 0 });
	const merged = mergeResults(ms.items, ovsx.items).slice(0, pageSize);
	const total = Math.max(ms.total, ovsx.total, merged.length);
	return {
		total,
		body: JSON.stringify({ results: [{
			extensions: merged.map(extension => rewriteGalleryExtension(extension.galleryExtension!, extension.source, origin)),
			pagingToken: null,
			resultMetadata: [
				{ metadataType: 'ResultCount', metadataItems: [{ name: 'TotalCount', count: total }] },
				{ metadataType: 'Fragment', metadataItems: responses.map((result, index) => ({
					name: index === 0 ? 'microsoft' : 'openvsx', count: result.status === 'fulfilled' ? 1 : 0
				})) }
			]
		}] })
	};
}

async function fetchGallery(source: Source, body: GalleryQueryBody, platform: string | null, signal: AbortSignal) {
	const url = new URL(GALLERIES[source]);
	if (platform) url.searchParams.set('targetPlatform', platform);
	const response = await fetch(url.toString(), {
		method: 'POST',
		headers: {
			accept: 'application/json; api-version=7.2-preview.1; excludeUrls=true',
			'content-type': 'application/json',
			'user-agent': 'sidex-marketplace-proxy/1.0'
		},
		body: JSON.stringify(body), signal
	});
	if (!response.ok) throw new Error(`${source} gallery ${response.status}`);
	const json = await response.json() as GalleryResponse;
	const result = json.results?.[0];
	const items = (result?.extensions ?? []).map(normalizeMsExtension)
		.filter((item): item is NormalizedExtension => !!item)
		.map(item => ({ ...item, source }));
	const total = result?.resultMetadata?.find(item => item.metadataType === 'ResultCount')
		?.metadataItems.find(item => item.name === 'TotalCount')?.count ?? items.length;
	return { items, total };
}

function proxyUrl(url: string, base: string): string {
	return `${base}/${btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

function rewriteGalleryExtension(extension: MsExtension, source: Source, origin: string): MsExtension {
	return {
		...extension,
		versions: extension.versions.map(version => ({
			...version,
			assetUri: version.assetUri ? proxyUrl(version.assetUri, `${origin}/api/asset/${source}`) : undefined,
			fallbackAssetUri: version.fallbackAssetUri || version.assetUri
				? proxyUrl(version.fallbackAssetUri || version.assetUri!, `${origin}/api/asset/${source}`) : undefined,
			files: version.files?.map(file => ({ ...file, source: proxyUrl(file.source, `${origin}/api/download/${source}`) }))
		}))
	};
}
