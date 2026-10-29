import { localize } from '../../../../../nls.js';
import type { DropdownOption } from './sidexSettingsStyles.js';

/** Translate the display label only: stored settings keep their stable, language-independent values. */
export function settingOptionLabel(value: string): string {
	const labels: Record<string, string> = {
		Default: localize('option.default', 'Default'),
		Small: localize('option.small', 'Small'),
		Large: localize('option.large', 'Large'),
		Custom: localize('option.custom', 'Custom'),
		Unlimited: localize('option.unlimited', 'Unlimited'),
		'Send after current message': localize('option.sendAfter', 'Send after current message'),
		'Queue all': localize('option.queueAll', 'Queue all'),
		'Ask each time': localize('option.askEachTime', 'Ask each time'),
		Auto: localize('option.auto', 'Auto'),
		Always: localize('option.always', 'Always'),
		Never: localize('option.never', 'Never'),
		Quick: localize('option.quick', 'Quick'),
		Thorough: localize('option.thorough', 'Thorough'),
		'Early Access': localize('option.earlyAccess', 'Early Access'),
		Off: localize('option.off', 'Off'),
		Editor: localize('option.editor', 'Editor'),
		Agent: localize('option.agent', 'Agent'),
		Compact: localize('option.compact', 'Compact'),
		Comfortable: localize('option.comfortable', 'Comfortable'),
		Spacious: localize('option.spacious', 'Spacious'),
		Gutter: localize('option.gutter', 'Gutter'),
		Toolbar: localize('option.toolbar', 'Toolbar'),
		Both: localize('option.both', 'Both'),
		connected: localize('status.connected', 'Connected'),
		disconnected: localize('status.disconnected', 'Disconnected'),
		connecting: localize('status.connecting', 'Connecting'),
		error: localize('status.error', 'Error'),
		unknown: localize('status.unknown', 'Unknown')
	};
	return labels[value] ?? value;
}

export function localizedSettingOptions(options: readonly (string | DropdownOption)[]): DropdownOption[] {
	return options.map(option =>
		typeof option === 'string' ? { value: option, label: settingOptionLabel(option) } : option
	);
}
