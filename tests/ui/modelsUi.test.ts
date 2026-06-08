import { sendModelsUI, buildModelsUI } from '../../src/ui/modelsUi';
import { InlineKeyboard } from 'grammy';

describe('modelsUi', () => {
    it('sends a connection error message when not connected', async () => {
        const sendFn = jest.fn().mockResolvedValue(undefined);
        await sendModelsUI(sendFn, {
            getCurrentCdp: () => null,
            fetchQuota: async () => [],
        });

        expect(sendFn).toHaveBeenCalledTimes(1);
        expect(sendFn.mock.calls[0][0]).toBe('Not connected to CDP.');
        expect(sendFn.mock.calls[0][1]).toBeInstanceOf(InlineKeyboard);
    });

    it('sends text and keyboard when models are available', async () => {
        const sendFn = jest.fn().mockResolvedValue(undefined);
        const cdp = {
            getUiModels: jest.fn().mockResolvedValue(['Model A', 'Model B']),
            getCurrentModel: jest.fn().mockResolvedValue('Model A'),
        };

        await sendModelsUI(sendFn, {
            getCurrentCdp: () => cdp as any,
            fetchQuota: async () => [],
        });

        expect(sendFn).toHaveBeenCalledTimes(1);
        const text = sendFn.mock.calls[0][0] as string;
        expect(text).toContain('Model Management');
        expect(text).toContain('Model A');
        expect(text).toContain('Model B');
        expect(sendFn.mock.calls[0][1]).toBeInstanceOf(InlineKeyboard);
    });
});

describe('buildModelsUI', () => {
    it('falls back to AVAILABLE_MODELS when no models are retrieved from CDP', async () => {
        const cdp = {
            getUiModels: jest.fn().mockResolvedValue([]),
            getCurrentModel: jest.fn().mockResolvedValue(null),
        };

        const result = await buildModelsUI(cdp as any, async () => []);
        expect(result).not.toBeNull();
        expect(result!.text).toContain('Model Management');
        expect(result!.text).toContain('Available Models');
    });

    it('returns text and keyboard when models are available', async () => {
        const cdp = {
            getUiModels: jest.fn().mockResolvedValue(['Model A', 'Model B']),
            getCurrentModel: jest.fn().mockResolvedValue('Model A'),
        };

        const result = await buildModelsUI(cdp as any, async () => []);
        expect(result).not.toBeNull();
        expect(result!.text).toContain('Model Management');
        expect(result!.text).toContain('Model A');
        expect(result!.keyboard).toBeInstanceOf(InlineKeyboard);
    });

    it('shows exhausted status when remainingFraction is 0', async () => {
        const cdp = {
            getUiModels: jest.fn().mockResolvedValue(['Model A']),
            getCurrentModel: jest.fn().mockResolvedValue('Model A'),
        };
        const quota = [{
            label: 'Model A',
            model: 'model_a',
            quotaInfo: { remainingFraction: 0, resetTime: new Date(Date.now() + 3600000).toISOString() },
        }];

        const result = await buildModelsUI(cdp as any, async () => quota);
        expect(result!.text).toContain('Exhausted');
        expect(result!.text).toContain('⛔');
        expect(result!.text).not.toContain('100%');
    });

    it('shows percentage when remainingFraction is between 0 and 1', async () => {
        const cdp = {
            getUiModels: jest.fn().mockResolvedValue(['Model A']),
            getCurrentModel: jest.fn().mockResolvedValue('Model A'),
        };
        const quota = [{
            label: 'Model A',
            model: 'model_a',
            quotaInfo: { remainingFraction: 0.6, resetTime: new Date(Date.now() + 3600000).toISOString() },
        }];

        const result = await buildModelsUI(cdp as any, async () => quota);
        expect(result!.text).toContain('60%');
        expect(result!.text).toContain('🟢');
    });

    it('shows N/A when quotaInfo has NaN remainingFraction', async () => {
        const cdp = {
            getUiModels: jest.fn().mockResolvedValue(['Model A']),
            getCurrentModel: jest.fn().mockResolvedValue('Model A'),
        };
        const quota = [{
            label: 'Model A',
            model: 'model_a',
            quotaInfo: { remainingFraction: NaN, resetTime: '' },
        }];

        const result = await buildModelsUI(cdp as any, async () => quota);
        expect(result!.text).toContain('N/A');
        expect(result!.text).toContain('❓');
    });

    it('uses model_exhausted_ callback prefix for exhausted model buttons', async () => {
        const cdp = {
            getUiModels: jest.fn().mockResolvedValue(['Healthy Model', 'Dead Model']),
            getCurrentModel: jest.fn().mockResolvedValue('Healthy Model'),
        };
        const quota = [
            { label: 'Healthy Model', model: 'healthy', quotaInfo: { remainingFraction: 0.8, resetTime: '' } },
            { label: 'Dead Model', model: 'dead', quotaInfo: { remainingFraction: 0, resetTime: new Date(Date.now() + 3600000).toISOString() } },
        ];

        const result = await buildModelsUI(cdp as any, async () => quota);
        const kbData = JSON.stringify((result!.keyboard as any).inline_keyboard);
        expect(kbData).toContain('model_btn_Healthy Model');
        expect(kbData).toContain('model_exhausted_Dead Model');
        expect(kbData).toContain('⛔ Dead Model');
    });

    it('sendModelsUI delegates to buildModelsUI', async () => {
        const sendFn = jest.fn().mockResolvedValue(undefined);
        const cdp = {
            getUiModels: jest.fn().mockResolvedValue(['Model A']),
            getCurrentModel: jest.fn().mockResolvedValue('Model A'),
        };

        await sendModelsUI(sendFn, {
            getCurrentCdp: () => cdp as any,
            fetchQuota: async () => [],
        });

        const text = sendFn.mock.calls[0][0] as string;
        expect(text).toContain('Model A');
    });
});
