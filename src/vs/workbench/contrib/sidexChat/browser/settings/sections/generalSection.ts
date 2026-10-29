import { localizedSettingOptions } from '../settingLabels.js';
/*---------------------------------------------------------------------------------------------
 *  General section for SideX Settings panel.
 *  Renders using VS Code settings-editor row structure for 1:1 parity.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../../../nls.js';
import type { SettingsSection } from '../sidexSettingsPanel.js';
import { createCustomDropdown } from '../sidexSettingsStyles.js';
import { setLocalServerEnabled } from '../../localServer.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

interface SettingsData {
	[key: string]: unknown;
}

interface ModelOption {
	value: string;
	label: string;
}

export class GeneralSection implements SettingsSection {
	private _container: HTMLElement | null = null;
	private _invoke: TauriInvoke;
	private _settings: SettingsData = {};
	private _agentEnabled: boolean = true;
	private _modelOptions: ModelOption[] = [];

	constructor(invoke: TauriInvoke) {
		this._invoke = invoke;
	}

	async render(container: HTMLElement): Promise<void> {
		this._container = container;

		if (this._invoke) {
			try {
				const [general, agent] = await Promise.all([
					this._invoke('settings_get', { section: 'sidex.general' }),
					this._invoke('settings_get', { section: 'sidex.agent' })
				]);
				if (general) {
					this._settings = this._parseStoredSettings(general as SettingsData);
				}
				if (agent) {
					const agentSettings = this._parseStoredSettings(agent as SettingsData);
					this._agentEnabled = agentSettings.enabled !== false;
				}
			} catch {
				/* use defaults */
			}
			await this._loadModelOptions();
		}

		this._createSectionTitle(container, nls.localize('sidexSettingsGeneral', 'General'));

		const card = this._createCard(container);

		// 1. Built-in SideX agent
		this._addToggleRow(
			card,
			nls.localize('sidexBuiltInAgent', 'Enable built-in SideX agent'),
			nls.localize(
				'sidexBuiltInAgentDescription',
				'Run SideX’s local agent server. This does not affect external or system agents.'
			),
			'sidex.agent.enabled',
			this._agentEnabled
		);

		// 2. Default Model
		this._addDefaultModelRow(card);

		// 3. Default Agent Mode
		this._addSelectRow(
			card,
			nls.localize('sidexDefaultAgentMode', 'Default Agent Mode'),
			nls.localize(
				'sidexDefaultAgentModeDescription',
				'Set the default agent capability when starting a new workspace task.'
			),
			[
				{ value: 'agent', label: nls.localize('sidexAgentMode', 'Agent') },
				{ value: 'plan', label: nls.localize('sidexPlanMode', 'Plan') },
				{ value: 'ask', label: nls.localize('sidexAskMode', 'Ask') }
			],
			this._getSetting('defaultAgent', 'agent') as string,
			'sidex.general.defaultAgent'
		);

		// 4. Auto Scroll
		this._addToggleRow(
			card,
			nls.localize('sidexAutoScroll', 'Auto scroll on message'),
			nls.localize(
				'sidexAutoScrollDescription',
				'Automatically scroll the conversation viewport down when a new message is received.'
			),
			'sidex.general.autoScroll',
			this._getSetting('autoScroll', true) as boolean
		);
	}

	public renderPreferences(container: HTMLElement): void {
		this._renderPreferences(container);
	}

	public renderLayout(container: HTMLElement): void {
		this._renderLayout(container);
	}

	public renderNotifications(container: HTMLElement): void {
		this._renderNotifications(container);
	}

	public renderPrivacy(container: HTMLElement): void {
		this._renderPrivacy(container);
	}

	private _renderPreferences(container: HTMLElement): void {
		this._createSectionTitle(container, nls.localize('sidexSettingsPreferences', 'Preferences'));
		const card = this._createCard(container);

		const editorRow = this._createRow(
			card,
			nls.localize('sidexSettingsEditorSettings', 'Editor Settings'),
			nls.localize('sidexSettingsEditorSettingsDescription', 'Customize editor appearance and behavior')
		);
		this._addButton(editorRow, nls.localize('sidexSettingsOpen', 'Open'), () => {
			window.dispatchEvent(new CustomEvent('sidex-native-menu', { detail: 'settings' }));
		});

		const kbRow = this._createRow(
			card,
			nls.localize('sidexSettingsKeyboardShortcuts', 'Keyboard Shortcuts'),
			nls.localize('sidexSettingsKeyboardShortcutsDescription', 'Customize keybindings')
		);
		this._addButton(kbRow, nls.localize('sidexSettingsOpen', 'Open'), () => {
			window.dispatchEvent(new CustomEvent('sidex-native-menu', { detail: 'keybindings' }));
		});

		const importRow = this._createRow(
			card,
			nls.localize('sidexSettingsImportVsCode', 'Import Settings from VS Code'),
			nls.localize('sidexSettingsImportVsCodeDescription', 'Import your existing configuration')
		);
		this._addButton(importRow, nls.localize('sidexSettingsImport', 'Import'), () => {
			this._showToast(
				nls.localize('sidexSettingsImportComingSoon', 'Coming soon — VS Code settings import is not yet available.')
			);
		});

		const resetRow = this._createRow(
			card,
			nls.localize('sidexSettingsResetDismissedDialogs', "Reset Don't Ask Again Dialogs"),
			nls.localize('sidexSettingsResetDismissedDialogsDescription', 'Show previously dismissed dialogs')
		);
		this._addButton(resetRow, nls.localize('sidexSettingsShow', 'Show'), () => {
			if (this._invoke) {
				this._invoke('settings_update', { key: 'sidex.general.dismissedDialogs', value: {}, scope: 'user' })
					.then(() => {
						this._showToast(nls.localize('sidexSettingsDialogsReset', 'All dialogs have been reset.'));
					})
					.catch(() => {});
			}
		});
	}

	private _renderLayout(container: HTMLElement): void {
		this._createSectionTitle(container, nls.localize('sidex.ui.layout.a51190', 'Layout'));
		const card = this._createCard(container);

		this._addSelectRow(
			card,
			nls.localize('sidex.ui.windowLayout.eedb6f', 'Window Layout'),
			nls.localize('sidex.ui.chooseDefaultWindowArrangement.2214ed', 'Choose default window arrangement'),
			['Editor', 'Agent'],
			this._getSetting('windowLayout', 'Editor') as string,
			'sidex.general.windowLayout'
		);

		this._addSelectRow(
			card,
			nls.localize('sidex.ui.conversationDensity.d0fffb', 'Conversation Density'),
			nls.localize('sidex.ui.adjustChatMessageSpacing.8a4e55', 'Adjust chat message spacing'),
			['Compact', 'Comfortable', 'Spacious'],
			this._getSetting('conversationDensity', 'Comfortable') as string,
			'sidex.general.conversationDensity'
		);

		this._addToggleRow(
			card,
			nls.localize('sidex.ui.titleBar.d9abd3', 'Title Bar'),
			nls.localize('sidex.ui.showTheWindowTitleBar.0ff30e', 'Show the window title bar'),
			'sidex.general.titleBar',
			this._getSetting('titleBar', true) as boolean
		);

		this._addToggleRow(
			card,
			nls.localize('sidex.ui.statusBar.3ef6e9', 'Status Bar'),
			nls.localize('sidex.ui.showTheStatusBarAtTheBottom.27f7e1', 'Show the status bar at the bottom'),
			'sidex.general.statusBar',
			this._getSetting('statusBar', true) as boolean
		);

		this._addSelectRow(
			card,
			nls.localize('sidex.ui.reviewControlLocation.3b4985', 'Review Control Location'),
			nls.localize('sidex.ui.whereToShowReviewControls.81bfa9', 'Where to show review controls'),
			['Gutter', 'Toolbar', 'Both'],
			this._getSetting('reviewControlLocation', 'Gutter') as string,
			'sidex.general.reviewControlLocation'
		);

		this._addToggleRow(
			card,
			nls.localize('sidex.ui.autoHideEditorWhenEmpty.413b32', 'Auto-hide editor when empty'),
			nls.localize('sidex.ui.collapseEditorPanelIfNoTabsAre.8aafb7', 'Collapse editor panel if no tabs are open'),
			'sidex.general.autoHideEditor',
			this._getSetting('autoHideEditor', false) as boolean
		);

		const tabsRow = this._addToggleRow(
			card,
			nls.localize('sidex.ui.openChatAsEditorTabs.ed05ed', 'Open chat as editor tabs'),
			'',
			'sidex.general.chatAsTabs',
			this._getSetting('chatAsTabs', false) as boolean
		);
		const badge = document.createElement('span');
		badge.className = 'sidex-settings-new-badge';
		badge.textContent = nls.localize('sidexSettingsNew', 'NEW');
		tabsRow.querySelector('.sidex-settings-row-label')!.appendChild(badge);
	}

	private _renderNotifications(container: HTMLElement): void {
		this._createSectionTitle(container, nls.localize('sidexSettingsNotifications', 'Notifications'));
		const card = this._createCard(container);

		this._addToggleRow(
			card,
			nls.localize('sidexSettingsSystemNotifications', 'System Notifications'),
			nls.localize('sidexSettingsSystemNotificationsDescription', 'Show OS-level notifications'),
			'sidex.general.systemNotifications',
			this._getSetting('systemNotifications', true) as boolean
		);

		this._addToggleRow(
			card,
			nls.localize('sidexSettingsMenuBarIcon', 'Menu Bar Icon'),
			nls.localize('sidexSettingsMenuBarIconDescription', 'Show icon in the system tray/menu bar'),
			'sidex.general.menuBarIcon',
			this._getSetting('menuBarIcon', true) as boolean
		);

		this._addToggleRow(
			card,
			nls.localize('sidexSettingsCompletionSound', 'Completion Sound'),
			nls.localize('sidexSettingsCompletionSoundDescription', 'Play a sound when operations complete'),
			'sidex.general.completionSound',
			this._getSetting('completionSound', false) as boolean
		);
	}

	private _renderPrivacy(container: HTMLElement): void {
		this._createSectionTitle(container, nls.localize('sidexSettingsPrivacy', 'Privacy'));
		const card = this._createCard(container);
		this._addToggleRow(
			card,
			nls.localize('sidexSettingsDataSharing', 'Data Sharing'),
			nls.localize(
				'sidexSettingsDataSharingDescription',
				'Help improve SideX by sharing anonymous usage data. No code or personal information is ever collected.'
			),
			'sidex.general.dataSharing',
			this._getSetting('dataSharing', true) as boolean
		);
	}

	/**
	 * There is no curated model catalog anymore (see ModelsSection) — a
	 * default can only be one of the models the user has actually added,
	 * so this reads the same 'sidex.models.custom' list that section owns
	 * rather than hardcoding a preset.
	 */
	private async _loadModelOptions(): Promise<void> {
		if (!this._invoke) {
			return;
		}
		try {
			const raw = await this._invoke('settings_get', { section: 'sidex.models.custom' });
			const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
			if (!Array.isArray(arr)) {
				return;
			}
			this._modelOptions = arr
				.map((entry: string | { id?: string; name?: string }) => {
					const id = typeof entry === 'string' ? entry : entry?.id;
					if (!id) {
						return null;
					}
					const name = typeof entry === 'object' ? entry?.name : undefined;
					return { value: id, label: name ? `${name} (${id})` : id };
				})
				.filter((opt): opt is ModelOption => opt !== null);
		} catch {
			/* no models configured yet */
		}
	}

	private _addDefaultModelRow(card: HTMLElement): void {
		if (this._modelOptions.length === 0) {
			// Nothing to default to until the user adds a model — a dropdown
			// with no real entries would look broken rather than empty.
			const row = this._createRow(
				card,
				nls.localize('sidexDefaultModel', 'Default AI Model'),
				nls.localize(
					'sidexDefaultModelEmptyDescription',
					'Add a model in the Models section to set a default for new conversations.'
				)
			);
			this._addButton(row, nls.localize('sidexConfigureModels', 'Configure Models'), () => {
				window.dispatchEvent(new CustomEvent('sidex-settings-navigate', { detail: 'models' }));
			});
			return;
		}

		// A blank saved value means "no override" — represent that as its own
		// option instead of silently defaulting the dropdown to whichever
		// model happens to be first, which would look chosen without being saved.
		const options: ModelOption[] = [
			{ value: '', label: nls.localize('sidexNoDefaultModel', 'No default (use first available)') },
			...this._modelOptions
		];
		this._addSelectRow(
			card,
			nls.localize('sidexDefaultModel', 'Default AI Model'),
			nls.localize(
				'sidexDefaultModelDescription',
				'Select which AI model new conversations will start with by default.'
			),
			options,
			this._getSetting('defaultModel', '') as string,
			'sidex.general.defaultModel'
		);
	}

	// --- Helpers ---

	private _getSetting(key: string, defaultValue: unknown): unknown {
		return this._settings[key] ?? defaultValue;
	}

	private _parseStoredSettings(data: SettingsData): SettingsData {
		return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, this._parseStoredValue(value)]));
	}

	private _parseStoredValue(value: unknown): unknown {
		if (typeof value !== 'string') {
			return value;
		}

		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}

	private _saveSetting(key: string, value: unknown): void {
		if (!this._invoke) {
			return;
		}
		this._invoke('settings_update', { key, value, scope: 'user' })
			.then(() => {
				if (key === 'sidex.agent.enabled' && typeof value === 'boolean') {
					setLocalServerEnabled(value);
				}
				window.dispatchEvent(new CustomEvent('sidex-settings-changed'));
			})
			.catch(() => {});
	}

	private _showToast(message: string): void {
		const existing = document.querySelector('.sidex-settings-toast');
		if (existing) {
			existing.remove();
		}

		const toast = document.createElement('div');
		toast.className = 'sidex-settings-toast';
		toast.style.cssText =
			'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:6px;font-size:12px;z-index:10000;';
		toast.style.background = 'var(--vscode-notifications-background)';
		toast.style.color = 'var(--vscode-notifications-foreground)';
		toast.style.border = '1px solid var(--vscode-widget-border)';
		toast.style.boxShadow = 'var(--vscode-shadow-xl)';
		toast.textContent = message;
		document.body.appendChild(toast);
		setTimeout(() => toast.remove(), 3000);
	}

	private _createSectionTitle(parent: HTMLElement, text: string): void {
		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = text;
		parent.appendChild(title);
	}

	private _createCard(parent: HTMLElement): HTMLElement {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';
		parent.appendChild(card);
		return card;
	}

	private _createRow(parent: HTMLElement, label: string, description?: string): HTMLElement {
		const row = document.createElement('div');
		row.className = 'sidex-settings-row';

		const left = document.createElement('div');
		const lbl = document.createElement('div');
		lbl.className = 'sidex-settings-row-label';
		lbl.textContent = label;
		left.appendChild(lbl);

		if (description) {
			const desc = document.createElement('div');
			desc.className = 'sidex-settings-row-description';
			desc.textContent = description;
			left.appendChild(desc);
		}
		row.appendChild(left);

		const action = document.createElement('div');
		action.className = 'sidex-settings-row-action';
		row.appendChild(action);

		parent.appendChild(row);
		return row;
	}

	private _addButton(row: HTMLElement, text: string, onClick: () => void): void {
		const btn = document.createElement('button');
		btn.className = 'sidex-settings-btn';
		btn.textContent = text;
		btn.addEventListener('click', onClick);
		row.querySelector('.sidex-settings-row-action')!.appendChild(btn);
	}

	private _addToggleRow(
		parent: HTMLElement,
		label: string,
		description: string,
		settingKey: string,
		initialState: boolean
	): HTMLElement {
		const row = this._createRow(parent, label, description);
		const toggle = document.createElement('div');
		toggle.className = 'sidex-settings-toggle' + (initialState ? ' on' : '');
		toggle.setAttribute('role', 'checkbox');
		toggle.setAttribute('aria-checked', String(initialState));
		toggle.setAttribute('aria-label', label);
		toggle.tabIndex = 0;
		toggle.addEventListener('click', () => {
			const isOn = toggle.classList.toggle('on');
			toggle.setAttribute('aria-checked', String(isOn));
			this._saveSetting(settingKey, isOn);
		});
		row.querySelector('.sidex-settings-row-action')!.appendChild(toggle);
		return row;
	}

	private _addSelectRow(
		parent: HTMLElement,
		label: string,
		description: string,
		options: any[],
		currentValue: string,
		settingKey: string
	): HTMLElement {
		const row = this._createRow(parent, label, description);
		const dropdown = createCustomDropdown(localizedSettingOptions(options), currentValue, newValue => {
			this._saveSetting(settingKey, newValue);
		});
		row.querySelector('.sidex-settings-row-action')!.appendChild(dropdown);
		return row;
	}

	dispose(): void {
		this._container = null;
	}
}
