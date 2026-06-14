import { t } from "../utils/i18n";
import { ConfigLoader } from "../utils/configLoader";
import { ApprovalType } from "./approvalDetector";

export type AutoAcceptAction = 'on' | 'off' | 'status';

export interface AutoAcceptCommandResult {
    success: boolean;
    enabled: boolean;
    changed: boolean;
    message: string;
}

export interface AutoAcceptSettings {
    enabled: boolean;
    fileEdits: boolean;
    consoleCommands: boolean;
    readAccess: boolean;
    urlAccess: boolean;
    browserAccess: boolean;
    otherRequests: boolean;
    autoApproveAlways: boolean;
    notifyOnAutoApprove: boolean;
    approvalMirrorMode: 'all' | 'active' | 'telegram_only';
}

export class AutoAcceptService {
    private settings: AutoAcceptSettings;

    constructor(initialSettings: AutoAcceptSettings) {
        this.settings = { ...initialSettings };
    }

    isEnabled(): boolean {
        return this.settings.enabled;
    }

    isCategoryEnabled(category: ApprovalType): boolean {
        if (!this.settings.enabled) return false;
        switch (category) {
            case 'file_edits': return this.settings.fileEdits;
            case 'console_commands': return this.settings.consoleCommands;
            case 'read_access': return this.settings.readAccess;
            case 'url_access': return this.settings.urlAccess;
            case 'browser_access': return this.settings.browserAccess;
            case 'other_requests': return this.settings.otherRequests;
            default: return false;
        }
    }

    getSettings(): AutoAcceptSettings {
        return this.settings;
    }

    toggleMaster(enabled: boolean): void {
        this.settings.enabled = enabled;
        ConfigLoader.save({ autoApprove: enabled });
    }

    toggleCategory(category: 'fileEdits' | 'consoleCommands' | 'readAccess' | 'urlAccess' | 'browserAccess' | 'otherRequests' | 'autoApproveAlways' | 'notifyOnAutoApprove', enabled: boolean): void {
        (this.settings as any)[category] = enabled;
        const configKey = this.mapSettingToConfigKey(category);
        if (configKey) {
            ConfigLoader.save({ [configKey]: enabled });
        }
    }

    setApprovalMirrorMode(mode: 'all' | 'active' | 'telegram_only'): void {
        this.settings.approvalMirrorMode = mode;
        ConfigLoader.save({ approvalMirrorMode: mode });
    }

    private mapSettingToConfigKey(setting: string): string | null {
        switch (setting) {
            case 'fileEdits': return 'autoApproveFileEdits';
            case 'consoleCommands': return 'autoApproveConsoleCommands';
            case 'readAccess': return 'autoApproveReadAccess';
            case 'urlAccess': return 'autoApproveUrlAccess';
            case 'browserAccess': return 'autoApproveBrowserAccess';
            case 'otherRequests': return 'autoApproveOtherRequests';
            case 'autoApproveAlways': return 'autoApproveAlways';
            case 'notifyOnAutoApprove': return 'notifyOnAutoApprove';
            default: return null;
        }
    }

    handle(rawAction?: string): AutoAcceptCommandResult {
        const action = this.normalizeAction(rawAction);
        if (!action) {
            return {
                success: false,
                enabled: this.settings.enabled,
                changed: false,
                message: t('⚠️ Invalid argument. Usage: `/autoaccept [on/off/status]`'),
            };
        }

        if (action === 'status') {
            return {
                success: true,
                enabled: this.settings.enabled,
                changed: false,
                message: t(`⚙️ Auto-accept mode: **${this.settings.enabled ? 'ON' : 'OFF'}**`),
            };
        }

        if (action === 'on') {
            if (this.settings.enabled) {
                return {
                    success: true,
                    enabled: true,
                    changed: false,
                    message: t('ℹ️ Auto-accept mode is already **ON**.'),
                };
            }
            this.toggleMaster(true);
            return {
                success: true,
                enabled: true,
                changed: true,
                message: t('✅ Auto-accept mode turned **ON**. Future dialogs will be auto-allowed.'),
            };
        }

        if (!this.settings.enabled) {
            return {
                success: true,
                enabled: false,
                changed: false,
                message: t('ℹ️ Auto-accept mode is already **OFF**.'),
            };
        }

        this.toggleMaster(false);
        return {
            success: true,
            enabled: false,
            changed: true,
            message: t('✅ Auto-accept mode turned **OFF**. Returned to manual approval.'),
        };
    }

    private normalizeAction(rawAction?: string): AutoAcceptAction | null {
        if (!rawAction || rawAction.trim().length === 0) return 'status';

        const normalized = rawAction.trim().toLowerCase();
        if (['on', 'enable', 'enabled', 'true', '1'].includes(normalized)) {
            return 'on';
        }
        if (['off', 'disable', 'disabled', 'false', '0'].includes(normalized)) {
            return 'off';
        }
        if (['status', 'state', 'show'].includes(normalized)) {
            return 'status';
        }
        return null;
    }
}
