import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const xml = value =>
	value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function digest(filename) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	return hash.digest('hex');
}

export async function collectReleaseArtifacts(directory, version, releaseBase) {
	const artifacts = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			artifacts.push(...(await collectReleaseArtifacts(filename, version, releaseBase)));
			continue;
		}
		if (!entry.isFile()) continue;
		const match = /^SideX_(.+)_(x64|amd64|x86_64|arm64|aarch64|universal)(-setup)?\.(exe|dmg|deb)$/i.exec(entry.name);
		if (!match) continue;
		if (match[1] !== version) throw new Error(`${entry.name} does not match release version ${version}`);
		const type = match[4].toLowerCase();
		const architecture = {
			x64: 'x64',
			amd64: 'x64',
			x86_64: 'x64',
			arm64: 'arm64',
			aarch64: 'arm64',
			universal: 'universal'
		}[match[2].toLowerCase()];
		if ((type === 'exe' && !match[3]) || (architecture === 'universal' && type !== 'dmg')) continue;
		if (!(await fs.stat(filename)).size) throw new Error(`Empty release artifact: ${filename}`);
		artifacts.push({
			type,
			architecture,
			name: entry.name,
			file: path.resolve(filename),
			sha256: await digest(filename),
			url: `${releaseBase}/${encodeURIComponent(entry.name)}`
		});
	}
	return artifacts;
}

function flatpakManifest({ appId, version, repository, artifact, runtimeVersion, localPath }) {
	return {
		'app-id': appId,
		runtime: 'org.gnome.Platform',
		'runtime-version': runtimeVersion,
		sdk: 'org.gnome.Sdk',
		command: 'SideX',
		'finish-args': [
			'--share=ipc',
			'--socket=wayland',
			'--socket=fallback-x11',
			'--device=dri',
			'--share=network',
			'--socket=ssh-auth',
			'--filesystem=host',
			'--persist=.sidex',
			'--talk-name=org.freedesktop.Flatpak',
			'--talk-name=org.kde.StatusNotifierWatcher',
			'--filesystem=xdg-run/tray-icon:create',
			'--env=SHELL=/app/bin/sidex-host-shell'
		],
		'separate-locales': false,
		modules: [
			'shared-modules/libayatana-appindicator/libayatana-appindicator-gtk3.json',
			{
				name: 'sidex',
				buildsystem: 'simple',
				'build-commands': [
					'sh extract-deb.sh sidex.deb',
					'test -f usr/lib/SideX/extension-host/host.cjs',
					'test -x usr/lib/SideX/runtime/node/bin/node',
					'install -Dm755 usr/bin/SideX /app/bin/SideX',
					'mkdir -p /app/lib && cp -a usr/lib/SideX /app/lib/SideX',
					'install -Dm755 host-shell.sh /app/bin/sidex-host-shell',
					`install -Dm644 ${appId}.desktop /app/share/applications/${appId}.desktop`,
					`install -Dm644 ${appId}.metainfo.xml /app/share/metainfo/${appId}.metainfo.xml`,
					`for icon in usr/share/icons/hicolor/*/apps/SideX.png; do test -f "$icon" || continue; size=$(basename "$(dirname "$(dirname "$icon")")"); install -Dm644 "$icon" "/app/share/icons/hicolor/$size/apps/${appId}.png"; done`
				],
				sources: [
					{
						type: 'file',
						...(localPath ? { path: localPath } : { url: artifact.url, sha256: artifact.sha256 }),
						'dest-filename': 'sidex.deb',
						'only-arches': [artifact.architecture === 'x64' ? 'x86_64' : 'aarch64']
					},
					...['extract-deb.sh', 'host-shell.sh', `${appId}.desktop`, `${appId}.metainfo.xml`].map(file => ({
						type: 'file',
						path: file
					}))
				]
			}
		]
	};
}

export async function generatePackageManifests(options) {
	const version = String(options.version).replace(/^v/, '');
	if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version))
		throw new Error('Provide a semantic --version such as 0.1.3');
	const repository = options.repository ?? 'naulbi-dump-projects/sidex';
	if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Repository must be owner/name');
	const appId = options.appId ?? 'dev.sidex.app';
	if (!/^[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*){2,}$/.test(appId)) throw new Error('Invalid reverse-DNS application ID');
	const packageId = options.packageId ?? 'Naulbi.SideX';
	if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(packageId)) throw new Error('Invalid winget package identifier');
	const releaseBase = new URL(options.releaseBase ?? `https://github.com/${repository}/releases/download/v${version}`);
	if (
		releaseBase.protocol !== 'https:' ||
		releaseBase.username ||
		releaseBase.password ||
		releaseBase.search ||
		releaseBase.hash
	)
		throw new Error('Release base must be an HTTPS URL without credentials, query, or fragment');
	const output = path.resolve(options.output ?? 'dist/package-manifests');
	const artifacts = await collectReleaseArtifacts(
		path.resolve(options.artifacts),
		version,
		releaseBase.href.replace(/\/$/, '')
	);
	if (!artifacts.length) throw new Error('No matching SideX .deb, .dmg, or NSIS installer artifacts found');
	const identities = new Set();
	for (const artifact of artifacts) {
		const identity = `${artifact.type}/${artifact.architecture}`;
		if (identities.has(identity)) throw new Error(`More than one release artifact for ${identity}`);
		identities.add(identity);
	}
	await fs.mkdir(output, { recursive: true });
	const homepage = `https://github.com/${repository}`;
	const windows = artifacts.filter(artifact => artifact.type === 'exe');
	if (windows.length) {
		const directory = path.join(output, 'winget');
		await fs.mkdir(directory, { recursive: true });
		const common = { PackageIdentifier: packageId, PackageVersion: version, ManifestVersion: '1.6.0' };
		const documents = {
			[`${packageId}.yaml`]: { ...common, DefaultLocale: 'en-US', ManifestType: 'version' },
			[`${packageId}.installer.yaml`]: {
				...common,
				InstallerType: 'nullsoft',
				UpgradeBehavior: 'install',
				Installers: windows.flatMap(artifact =>
					['user', 'machine'].map(scope => ({
						Architecture: artifact.architecture,
						Scope: scope,
						InstallerSwitches: { Custom: scope === 'user' ? '/CurrentUser' : '/AllUsers' },
						InstallerUrl: artifact.url,
						InstallerSha256: artifact.sha256.toUpperCase()
					}))
				),
				ManifestType: 'installer'
			},
			[`${packageId}.locale.en-US.yaml`]: {
				...common,
				PackageLocale: 'en-US',
				Publisher: 'SideX contributors',
				PackageName: 'SideX',
				License: 'MIT',
				LicenseUrl: `${homepage}/blob/main/LICENSE`,
				PackageUrl: homepage,
				ShortDescription: 'Native code editor built with the VS Code workbench and Tauri',
				ManifestType: 'defaultLocale'
			}
		};
		for (const [filename, data] of Object.entries(documents))
			await fs.writeFile(path.join(directory, filename), JSON.stringify(data, null, 2) + '\n');
	}
	const mac = artifacts.filter(artifact => artifact.type === 'dmg');
	if (mac.length) {
		const universal = mac.find(artifact => artifact.architecture === 'universal');
		let downloads;
		if (universal) downloads = `  sha256 ${JSON.stringify(universal.sha256)}\n  url ${JSON.stringify(universal.url)}`;
		else {
			downloads = mac
				.map(
					artifact =>
						`  on_${artifact.architecture === 'arm64' ? 'arm' : 'intel'} do\n    sha256 ${JSON.stringify(artifact.sha256)}\n    url ${JSON.stringify(artifact.url)}\n  end`
				)
				.join('\n');
			if (mac.length === 1)
				downloads += `\n  depends_on arch: :${mac[0].architecture === 'arm64' ? 'arm64' : 'x86_64'}`;
		}
		await fs.writeFile(
			path.join(output, 'sidex.rb'),
			`cask "sidex" do\n  version ${JSON.stringify(version)}\n${downloads}\n  name "SideX"\n  desc "Native code editor with the VS Code workbench and Tauri"\n  homepage ${JSON.stringify(homepage)}\n  depends_on macos: ">= :monterey"\n  app "SideX.app"\nend\n`
		);
	}
	for (const artifact of artifacts.filter(artifact => artifact.type === 'deb')) {
		const directory = path.join(output, 'flatpak', artifact.architecture);
		await fs.mkdir(directory, { recursive: true });
		await fs.cp(path.join(root, 'packaging/flatpak/shared-modules'), path.join(directory, 'shared-modules'), {
			recursive: true
		});
		for (const filename of ['extract-deb.sh', 'host-shell.sh'])
			await fs.copyFile(path.join(root, 'packaging/flatpak', filename), path.join(directory, filename));
		await fs.writeFile(
			path.join(directory, `${appId}.desktop`),
			`[Desktop Entry]\nType=Application\nName=SideX\nGenericName=Code Editor\nGenericName[ru]=Редактор кода\nGenericName[zh_CN]=代码编辑器\nGenericName[zh_TW]=程式碼編輯器\nExec=SideX %F\nIcon=${appId}\nTerminal=false\nCategories=Development;IDE;TextEditor;\nStartupWMClass=SideX\nMimeType=text/plain;inode/directory;\n`
		);
		await fs.writeFile(
			path.join(directory, `${appId}.metainfo.xml`),
			`<?xml version="1.0" encoding="UTF-8"?>\n<component type="desktop-application">\n  <id>${xml(appId)}</id>\n  <metadata_license>CC0-1.0</metadata_license>\n  <project_license>MIT</project_license>\n  <name>SideX</name>\n  <summary>Native code editor with the VS Code workbench</summary>\n  <summary xml:lang="ru">Нативный редактор кода с интерфейсом VS Code</summary>\n  <summary xml:lang="zh_CN">基于 VS Code 工作台的原生代码编辑器</summary>\n  <summary xml:lang="zh_TW">採用 VS Code 工作台的原生程式碼編輯器</summary>\n  <description><p>SideX combines a native Tauri desktop application with the VS Code editor and workbench.</p></description>\n  <url type="homepage">${xml(homepage)}</url>\n  <url type="bugtracker">${xml(homepage)}/issues</url>\n  <launchable type="desktop-id">${xml(appId)}.desktop</launchable>\n  <content_rating type="oars-1.1"/>\n</component>\n`
		);
		const specification = { appId, version, repository, artifact, runtimeVersion: options.runtimeVersion ?? '50' };
		for (const [filename, localPath] of [
			['manifest.json', undefined],
			['manifest.local.json', path.relative(directory, artifact.file)]
		]) {
			await fs.writeFile(
				path.join(directory, filename),
				JSON.stringify(flatpakManifest({ ...specification, localPath }), null, 2) + '\n'
			);
		}
	}
	await fs.writeFile(
		path.join(output, 'artifacts.json'),
		JSON.stringify({ version, repository, artifacts: artifacts.map(({ file, ...artifact }) => artifact) }, null, 2) +
			'\n'
	);
	return { output, artifacts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = {};
		const names = {
			'--artifacts': 'artifacts',
			'--version': 'version',
			'--output': 'output',
			'--repository': 'repository',
			'--app-id': 'appId',
			'--package-id': 'packageId',
			'--release-base': 'releaseBase',
			'--runtime-version': 'runtimeVersion'
		};
		for (let index = 2; index < process.argv.length; index++) {
			const name = names[process.argv[index]];
			if (!name || !process.argv[index + 1] || process.argv[index + 1].startsWith('--'))
				throw new Error(`Unknown or incomplete option: ${process.argv[index]}`);
			options[name] = process.argv[++index];
		}
		if (!options.artifacts || !options.version)
			throw new Error(
				'Usage: node scripts/package-manifests.mjs --artifacts <directory> --version <version> [--output <directory>]'
			);
		const result = await generatePackageManifests(options);
		console.log(`Generated package manifests from ${result.artifacts.length} real artifacts in ${result.output}`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
