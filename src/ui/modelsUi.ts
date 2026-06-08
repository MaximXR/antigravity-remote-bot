import { InlineKeyboard } from 'grammy';

import { CdpService } from '../services/cdpService';
import { escapeHtml } from '../utils/telegramFormatter';

import { AVAILABLE_MODELS } from '../services/modelService';

export interface ModelsUiDeps {
    getCurrentCdp: () => CdpService | null;
    fetchQuota: () => Promise<any[]>;
}

export interface ModelsUiPayload {
    text: string;
    keyboard: InlineKeyboard;
}

export async function buildModelsUI(
    cdp: CdpService,
    fetchQuota: () => Promise<any[]>,
): Promise<ModelsUiPayload | null> {
    let models = await cdp.getUiModels();
    if (models.length === 0) {
        models = [...AVAILABLE_MODELS];
    }
    const currentModel = await cdp.getCurrentModel();
    const quotaData = await fetchQuota();

    function formatQuota(mName: string, current: boolean) {
        if (!mName) return `${current ? '✅' : '⬜'} Unknown`;

        const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_]/g, '');
        const nName = normalize(mName);
        const q = quotaData.find(q => {
            const nLabel = normalize(q.label);
            const nModel = normalize(q.model || '');
            return nLabel === nName || nModel === nName
                || nName.includes(nLabel) || nLabel.includes(nName)
                || (nModel && (nName.includes(nModel) || nModel.includes(nName)));
        });
        if (!q || !q.quotaInfo) return `${current ? '✅' : '⬜'} ${mName}`;

        const rem = q.quotaInfo.remainingFraction;
        const resetTime = q.quotaInfo.resetTime ? new Date(q.quotaInfo.resetTime) : null;
        const diffMs = resetTime ? resetTime.getTime() - Date.now() : 0;
        let timeStr = 'Ready';
        if (diffMs > 0) {
            const mins = Math.ceil(diffMs / 60000);
            if (mins < 60) timeStr = `${mins}m`;
            else timeStr = `${Math.floor(mins / 60)}h ${mins % 60}m`;
        }

        if (rem !== undefined && rem !== null && !isNaN(rem)) {
            const percent = Math.round(rem * 100);
            let icon = '🟢';
            if (percent <= 0) icon = '⛔';
            else if (percent <= 20) icon = '🔴';
            else if (percent <= 50) icon = '🟡';
            const quotaStr = percent <= 0 ? 'Exhausted' : `${percent}%`;
            return `${current ? '✅' : '⬜'} ${mName} ${icon} ${quotaStr} (⏱️ ${timeStr})`;
        }

        return `${current ? '✅' : '⬜'} ${mName} ❓ N/A (⏱️ ${timeStr})`;
    }

    const currentModelFormatted = currentModel ? formatQuota(currentModel, true) : 'Unknown';

    const text =
        `<b>Model Management</b>\n\n` +
        `<b>Current Model:</b>\n${escapeHtml(currentModelFormatted)}\n\n` +
        `<b>Available Models (${models.length})</b>\n` +
        models.map(m => escapeHtml(formatQuota(m, m === currentModel))).join('\n');

    const isExhausted = (mName: string): boolean => {
        if (!mName) return false;
        const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_]/g, '');
        const nName = normalize(mName);
        const q = quotaData.find(q => {
            const nLabel = normalize(q.label);
            const nModel = normalize(q.model || '');
            return nLabel === nName || nModel === nName
                || nName.includes(nLabel) || nLabel.includes(nName)
                || (nModel && (nName.includes(nModel) || nModel.includes(nName)));
        });
        if (!q?.quotaInfo) return false;
        const rem = q.quotaInfo.remainingFraction;
        return typeof rem === 'number' && !isNaN(rem) && rem <= 0;
    };

    const keyboard = new InlineKeyboard();
    const MAX_BUTTONS = 24;
    for (const mName of models.slice(0, MAX_BUTTONS)) {
        const exhausted = isExhausted(mName);
        const safeName = mName.length > 40 ? mName.substring(0, 37) + '...' : mName;
        const label = exhausted ? `⛔ ${safeName}` : safeName;
        const maxNameLen = 64 - 'model_exhausted_'.length;
        const cbName = mName.length > maxNameLen ? mName.substring(0, maxNameLen) : mName;
        const cbData = exhausted ? `model_exhausted_${cbName}` : `model_btn_${cbName}`;
        keyboard.text(label, cbData).row();
    }
    keyboard.text('🔄 Refresh', 'model_refresh_btn').row();

    return { text, keyboard };
}

export async function sendModelsUI(
    sendFn: (text: string, keyboard: InlineKeyboard) => Promise<void>,
    deps: ModelsUiDeps,
): Promise<void> {
    const cdp = deps.getCurrentCdp();
    if (!cdp) {
        await sendFn('Not connected to CDP.', new InlineKeyboard());
        return;
    }

    const payload = await buildModelsUI(cdp, deps.fetchQuota);
    if (!payload) {
        await sendFn('Failed to retrieve model list from Antigravity.', new InlineKeyboard());
        return;
    }

    await sendFn(payload.text, payload.keyboard);
}
