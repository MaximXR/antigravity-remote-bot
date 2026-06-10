import {
    AUTOACCEPT_BTN_REFRESH,
    sendAutoAcceptUI,
} from '../../src/ui/autoAcceptUi';
import { AutoAcceptService, AutoAcceptSettings } from '../../src/services/autoAcceptService';
import { InlineKeyboard } from 'grammy';

const makeSettings = (enabled: boolean): AutoAcceptSettings => ({
    enabled,
    fileEdits: false,
    consoleCommands: false,
    readAccess: false,
    urlAccess: false,
    otherRequests: false,
});

describe('autoAcceptUi', () => {
    it('shows OFF status and sends keyboard when disabled', async () => {
        const sendFn = jest.fn().mockResolvedValue(undefined);
        const service = new AutoAcceptService(makeSettings(false));

        await sendAutoAcceptUI(sendFn, service);

        expect(sendFn).toHaveBeenCalledTimes(1);
        const text = sendFn.mock.calls[0][0] as string;
        expect(text).toContain('Auto-accept Settings');
        expect(text).toContain('OFF');
        expect(sendFn.mock.calls[0][1]).toBeInstanceOf(InlineKeyboard);
    });

    it('shows ON status when enabled', async () => {
        const sendFn = jest.fn().mockResolvedValue(undefined);
        const service = new AutoAcceptService(makeSettings(true));

        await sendAutoAcceptUI(sendFn, service);

        const text = sendFn.mock.calls[0][0] as string;
        expect(text).toContain('ON');
    });
});
