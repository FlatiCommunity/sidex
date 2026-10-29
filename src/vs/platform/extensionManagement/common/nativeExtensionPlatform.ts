/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWeb, platform } from '../../../base/common/platform.js';
import { arch } from '../../../base/common/process.js';
import { TargetPlatform } from '../../extensions/common/extensions.js';
import { getTargetPlatform, toTargetPlatform } from './extensionManagement.js';

let nativePlatform: Promise<TargetPlatform> | undefined;

/** Use the executable's architecture, not the WebView's user agent. */
export async function getCurrentExtensionTargetPlatform(): Promise<TargetPlatform> {
	if ((globalThis as any).__SIDEX_TAURI__ !== true) {
		return isWeb ? TargetPlatform.WEB : getTargetPlatform(platform, arch);
	}
	if (!nativePlatform) {
		nativePlatform = import('@tauri-apps/api/core').then(async ({ invoke }) => {
			const value = await invoke<string>('extension_get_target_platform');
			const target = toTargetPlatform(value);
			if (target === TargetPlatform.UNKNOWN || target === TargetPlatform.UNDEFINED) {
				throw new Error(`Unsupported native extension platform: ${value}`);
			}
			return target;
		}).catch(error => {
			nativePlatform = undefined;
			throw error;
		});
	}
	return nativePlatform;
}
