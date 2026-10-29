import type { NormalizedExtension } from './types';

const MS_GALLERY_API = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const MS_GALLERY_ACCEPT = 'application/json; api-version=7.2-preview.1; excludeUrls=true';

interface MsExtensionFile {
	assetType: string;
	source: string;
}

interface MsExtensionVersion {
	targetPlatform?: string;
	properties?: { key: string; value: string }[];
	version: string;
	files?: MsExtensionFile[];
	assetUri?: string;
	fallbackAssetUri?: string;
	lastUpdated?: string;
}

interface MsStatistic {
	statisticName: string;
	value: number;
}

export interface MsExtension {
	extensionId: string;
	extensionName: string;
	displayName: string;
	shortDescription?: string;
	publisher: { publisherName: string; displayName?: string };
	versions: MsExtensionVersion[];
	statistics?: MsStatistic[];
	releaseDate?: string;
	publishedDate?: string;
	lastUpdated?: string;
	categories?: string[];
	tags?: string[];
}

interface MsQueryResponse {
	results: {
		extensions: MsExtension[];
		resultMetadata?: { metadataType: string; metadataItems: { name: string; count: number }[] }[];
	}[];
}

/** Flags documented at https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionGalleryService.ts */
const FLAGS = {
	IncludeVersions: 0x1,
	IncludeFiles: 0x2,
	IncludeCategoryAndTags: 0x4,
	IncludeSharedAccounts: 0x8,
	IncludeVersionProperties: 0x10,
	ExcludeNonValidated: 0x20,
	IncludeInstallationTargets: 0x40,
	IncludeAssetUri: 0x80,
	IncludeStatistics: 0x100,
	IncludeLatestVersionOnly: 0x200,
	Unpublished: 0x1000
};

function statistic(ext: MsExtension, name: string): number {
	return ext.statistics?.find(s => s.statisticName === name)?.value ?? 0;
}

function pickFile(version: MsExtensionVersion, assetType: string): string | undefined {
	return version.files?.find(f => f.assetType === assetType)?.source;
}

export function normalizeMsExtension(ext: MsExtension): NormalizedExtension | undefined {
	const latest = ext.versions[0];
	if (!latest) {
		return undefined;
	}
	const icon = pickFile(latest, 'Microsoft.VisualStudio.Services.Icons.Default');
	const vsix = pickFile(latest, 'Microsoft.VisualStudio.Services.VSIXPackage');
	return {
		id: `${ext.publisher.publisherName}.${ext.extensionName}`,
		name: ext.extensionName,
		displayName: ext.displayName || ext.extensionName,
		description: ext.shortDescription ?? '',
		version: latest.version,
		publisher: ext.publisher.publisherName,
		installCount: statistic(ext, 'install'),
		rating: statistic(ext, 'averagerating'),
		iconUrl: icon,
		downloadUrl: vsix ?? '',
		source: 'microsoft',
		targetPlatform: latest.targetPlatform,
		galleryExtension: ext,
		lastUpdated: ext.lastUpdated ?? ext.releaseDate ?? ext.versions[0]?.lastUpdated,
		categories: ext.categories,
		tags: ext.tags,
		ratingCount: statistic(ext, 'ratingcount')
	};
}

export async function searchMicrosoftMarketplace(
	query: string,
	pageSize: number,
	signal: AbortSignal,
	offset = 0
): Promise<{ items: NormalizedExtension[]; total: number }> {
	const body = {
		filters: [
			{
				criteria: [
					{ filterType: 8, value: 'Microsoft.VisualStudio.Code' },
					{ filterType: 10, value: query || '' }
				],
				pageNumber: Math.floor(offset / pageSize) + 1,
				pageSize,
				sortBy: 0,
				sortOrder: 0
			}
		],
		flags:
			FLAGS.IncludeLatestVersionOnly |
			FLAGS.IncludeAssetUri |
			FLAGS.IncludeStatistics |
			FLAGS.IncludeFiles |
			FLAGS.IncludeVersionProperties |
			FLAGS.IncludeCategoryAndTags |
			FLAGS.ExcludeNonValidated
	};

	const res = await fetch(MS_GALLERY_API, {
		method: 'POST',
		headers: {
			accept: MS_GALLERY_ACCEPT,
			'content-type': 'application/json',
			'user-agent': 'sidex-marketplace-proxy/1.0'
		},
		body: JSON.stringify(body),
		signal
	});
	if (!res.ok) {
		throw new Error(`ms marketplace ${res.status}`);
	}
	const json = (await res.json()) as MsQueryResponse;
	const result = json.results[0];
	const items = (result?.extensions ?? [])
		.map(normalizeMsExtension)
		.filter((e): e is NormalizedExtension => !!e && !!e.downloadUrl);
	const total =
		result?.resultMetadata
			?.find(m => m.metadataType === 'ResultCount')
			?.metadataItems.find(i => i.name === 'TotalCount')?.count ?? items.length;
	return { items, total };
}
