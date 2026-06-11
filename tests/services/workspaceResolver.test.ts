import {
    resolveWorkspaceAndCdp,
    channelKeyFromChannel,
    WorkspaceResolverDeps,
    ResolveOutcome,
} from '../../src/services/workspaceResolver';
import { ChannelContext } from '../../src/services/messengerPort';

// ---------------------------------------------------------------------------
// channelKeyFromChannel
// ---------------------------------------------------------------------------
describe('channelKeyFromChannel', () => {
    it('returns chatId string for private chats (no threadId)', () => {
        expect(channelKeyFromChannel({ chatId: 123456 })).toBe('123456');
    });

    it('returns chatId:threadId for forum topics', () => {
        expect(channelKeyFromChannel({ chatId: 123456, threadId: 99 })).toBe('123456:99');
    });

    it('handles negative group chatIds', () => {
        expect(channelKeyFromChannel({ chatId: -1001234567890 })).toBe('-1001234567890');
    });

    it('handles negative chatId with threadId', () => {
        expect(channelKeyFromChannel({ chatId: -1001234567890, threadId: 42 }))
            .toBe('-1001234567890:42');
    });

    it('treats threadId=undefined as absent', () => {
        expect(channelKeyFromChannel({ chatId: 100, threadId: undefined })).toBe('100');
    });

    it('handles string chatId', () => {
        expect(channelKeyFromChannel({ chatId: '999' } as any)).toBe('999');
    });
});

// ---------------------------------------------------------------------------
// resolveWorkspaceAndCdp
// ---------------------------------------------------------------------------
describe('resolveWorkspaceAndCdp', () => {
    const channel: ChannelContext = { chatId: 12345 };
    const forumChannel: ChannelContext = { chatId: 12345, threadId: 7 };

    const fakeCdp = { isConnected: () => true } as any;

    function makeDeps(overrides: Partial<WorkspaceResolverDeps> = {}): WorkspaceResolverDeps {
        return {
            findBinding: jest.fn().mockReturnValue({ workspacePath: 'my-project' }),
            getWorkspacePath: jest.fn().mockReturnValue('/home/user/projects/my-project'),
            getOrConnect: jest.fn().mockResolvedValue(fakeCdp),
            extractProjectName: jest.fn().mockReturnValue('my-project'),
            onConnected: jest.fn(),
            ...overrides,
        };
    }

    // --- Success path ---

    it('returns ok:true when binding exists and CDP connects', async () => {
        const deps = makeDeps();
        const result = await resolveWorkspaceAndCdp(channel, deps);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.cdp).toBe(fakeCdp);
            expect(result.projectName).toBe('my-project');
            expect(result.workspacePath).toBe('/home/user/projects/my-project');
        }
    });

    it('calls findBinding with the correct channel key', async () => {
        const deps = makeDeps();
        await resolveWorkspaceAndCdp(channel, deps);

        expect(deps.findBinding).toHaveBeenCalledWith('12345');
    });

    it('uses forum channel key when threadId is present', async () => {
        const deps = makeDeps();
        await resolveWorkspaceAndCdp(forumChannel, deps);

        expect(deps.findBinding).toHaveBeenCalledWith('12345:7');
    });

    it('passes workspace name to getWorkspacePath', async () => {
        const deps = makeDeps();
        await resolveWorkspaceAndCdp(channel, deps);

        expect(deps.getWorkspacePath).toHaveBeenCalledWith('my-project');
    });

    it('passes full path to getOrConnect', async () => {
        const deps = makeDeps();
        await resolveWorkspaceAndCdp(channel, deps);

        expect(deps.getOrConnect).toHaveBeenCalledWith('/home/user/projects/my-project');
    });

    it('passes full path to extractProjectName', async () => {
        const deps = makeDeps();
        await resolveWorkspaceAndCdp(channel, deps);

        expect(deps.extractProjectName).toHaveBeenCalledWith('/home/user/projects/my-project');
    });

    it('invokes onConnected callback with cdp, projectName, and channel', async () => {
        const onConnected = jest.fn();
        const deps = makeDeps({ onConnected });
        await resolveWorkspaceAndCdp(channel, deps);

        expect(onConnected).toHaveBeenCalledWith(fakeCdp, 'my-project', channel);
    });

    it('succeeds even when onConnected is not provided', async () => {
        const deps = makeDeps({ onConnected: undefined });
        const result = await resolveWorkspaceAndCdp(channel, deps);

        expect(result.ok).toBe(true);
    });

    // --- No binding path ---

    it('returns no_binding when findBinding returns undefined', async () => {
        const deps = makeDeps({ findBinding: jest.fn().mockReturnValue(undefined) });
        const result = await resolveWorkspaceAndCdp(channel, deps);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('no_binding');
            expect(result.message).toContain('/workspace');
        }
    });

    it('does not call getWorkspacePath when no binding found', async () => {
        const getWorkspacePath = jest.fn();
        const deps = makeDeps({
            findBinding: jest.fn().mockReturnValue(undefined),
            getWorkspacePath,
        });
        await resolveWorkspaceAndCdp(channel, deps);

        expect(getWorkspacePath).not.toHaveBeenCalled();
    });

    it('does not call getOrConnect when no binding found', async () => {
        const getOrConnect = jest.fn();
        const deps = makeDeps({
            findBinding: jest.fn().mockReturnValue(undefined),
            getOrConnect,
        });
        await resolveWorkspaceAndCdp(channel, deps);

        expect(getOrConnect).not.toHaveBeenCalled();
    });

    it('does not invoke onConnected when no binding found', async () => {
        const onConnected = jest.fn();
        const deps = makeDeps({
            findBinding: jest.fn().mockReturnValue(undefined),
            onConnected,
        });
        await resolveWorkspaceAndCdp(channel, deps);

        expect(onConnected).not.toHaveBeenCalled();
    });

    // --- CDP failure path ---

    it('returns cdp_failed when getOrConnect throws', async () => {
        const deps = makeDeps({
            getOrConnect: jest.fn().mockRejectedValue(new Error('Connection refused')),
        });
        const result = await resolveWorkspaceAndCdp(channel, deps);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('cdp_failed');
            expect(result.message).toContain('my-project');
            expect(result.message).toContain('Connection refused');
            expect(result.message).toContain('--remote-debugging-port');
        }
    });

    it('returns cdp_failed when getWorkspacePath throws', async () => {
        const deps = makeDeps({
            getWorkspacePath: jest.fn().mockImplementation(() => {
                throw new Error('Path traversal detected');
            }),
        });
        const result = await resolveWorkspaceAndCdp(channel, deps);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('cdp_failed');
            expect(result.message).toContain('Path traversal detected');
        }
    });

    it('includes workspace name in cdp_failed message', async () => {
        const deps = makeDeps({
            findBinding: jest.fn().mockReturnValue({ workspacePath: 'cool-app' }),
            getOrConnect: jest.fn().mockRejectedValue(new Error('timeout')),
        });
        const result = await resolveWorkspaceAndCdp(channel, deps);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain('cool-app');
        }
    });

    it('handles error without message property (raw string throw)', async () => {
        const deps = makeDeps({
            getOrConnect: jest.fn().mockRejectedValue('raw string error'),
        });
        const result = await resolveWorkspaceAndCdp(channel, deps);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('cdp_failed');
            // Raw strings don't have .message, fallback to String(e)
            expect(result.message).toContain('raw string error');
        }
    });

    it('handles error with undefined message property', async () => {
        const deps = makeDeps({
            getOrConnect: jest.fn().mockRejectedValue({ message: undefined }),
        });
        const result = await resolveWorkspaceAndCdp(channel, deps);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('cdp_failed');
            // Object without .message falls back to String(e) → "[object Object]"
            expect(result.message).toContain('CDP connection failed');
        }
    });

    it('falls back to "unknown error" when thrown value is null', async () => {
        const deps = makeDeps({
            getOrConnect: jest.fn().mockRejectedValue(null),
        });
        const result = await resolveWorkspaceAndCdp(channel, deps);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('cdp_failed');
            expect(result.message).toContain('unknown error');
        }
    });

    it('does not invoke onConnected when CDP connection fails', async () => {
        const onConnected = jest.fn();
        const deps = makeDeps({
            getOrConnect: jest.fn().mockRejectedValue(new Error('fail')),
            onConnected,
        });
        await resolveWorkspaceAndCdp(channel, deps);

        expect(onConnected).not.toHaveBeenCalled();
    });

    // --- Channel key consistency ---

    describe('channel key consistency between binding save and lookup', () => {
        it('private chat: same key for callback and message contexts', async () => {
            // Simulates callback context (project selection)
            const callbackChannel: ChannelContext = { chatId: 55555 };
            // Simulates message context (subsequent message)
            const messageChannel: ChannelContext = { chatId: 55555 };

            expect(channelKeyFromChannel(callbackChannel))
                .toBe(channelKeyFromChannel(messageChannel));
        });

        it('forum topic: same key when both contexts have the same threadId', async () => {
            const callbackChannel: ChannelContext = { chatId: 55555, threadId: 10 };
            const messageChannel: ChannelContext = { chatId: 55555, threadId: 10 };

            expect(channelKeyFromChannel(callbackChannel))
                .toBe(channelKeyFromChannel(messageChannel));
        });

        it('forum topic: different keys when threadId differs', async () => {
            const callbackChannel: ChannelContext = { chatId: 55555, threadId: 10 };
            const messageChannel: ChannelContext = { chatId: 55555, threadId: 20 };

            expect(channelKeyFromChannel(callbackChannel))
                .not.toBe(channelKeyFromChannel(messageChannel));
        });

        it('forum topic: different keys when callback has no threadId but message does', async () => {
            const callbackChannel: ChannelContext = { chatId: 55555 };
            const messageChannel: ChannelContext = { chatId: 55555, threadId: 10 };

            expect(channelKeyFromChannel(callbackChannel))
                .not.toBe(channelKeyFromChannel(messageChannel));
        });
    });

    // --- Windows path scenarios ---

    describe('Windows path handling', () => {
        it('resolves correctly with Windows-style full paths', async () => {
            const deps = makeDeps({
                getWorkspacePath: jest.fn().mockReturnValue('D:\\Projects\\my-project'),
                extractProjectName: jest.fn().mockReturnValue('my-project'),
            });
            const result = await resolveWorkspaceAndCdp(channel, deps);

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.workspacePath).toBe('D:\\Projects\\my-project');
            }
            expect(deps.getOrConnect).toHaveBeenCalledWith('D:\\Projects\\my-project');
        });

        it('passes Windows path to extractProjectName', async () => {
            const deps = makeDeps({
                getWorkspacePath: jest.fn().mockReturnValue('D:\\Projects\\cool-app'),
            });
            await resolveWorkspaceAndCdp(channel, deps);

            expect(deps.extractProjectName).toHaveBeenCalledWith('D:\\Projects\\cool-app');
        });
    });

    // --- Discriminated union type safety ---

    describe('return type discrimination', () => {
        it('success result has all required fields', async () => {
            const deps = makeDeps();
            const result = await resolveWorkspaceAndCdp(channel, deps);

            expect(result).toHaveProperty('ok', true);
            expect(result).toHaveProperty('cdp');
            expect(result).toHaveProperty('projectName');
            expect(result).toHaveProperty('workspacePath');
        });

        it('no_binding error has reason and message', async () => {
            const deps = makeDeps({ findBinding: jest.fn().mockReturnValue(undefined) });
            const result = await resolveWorkspaceAndCdp(channel, deps);

            expect(result).toHaveProperty('ok', false);
            expect(result).toHaveProperty('reason', 'no_binding');
            expect(result).toHaveProperty('message');
        });

        it('cdp_failed error has reason and message', async () => {
            const deps = makeDeps({
                getOrConnect: jest.fn().mockRejectedValue(new Error('boom')),
            });
            const result = await resolveWorkspaceAndCdp(channel, deps);

            expect(result).toHaveProperty('ok', false);
            expect(result).toHaveProperty('reason', 'cdp_failed');
            expect(result).toHaveProperty('message');
        });

        it('no_binding and cdp_failed have different messages', async () => {
            const noBindingDeps = makeDeps({ findBinding: jest.fn().mockReturnValue(undefined) });
            const cdpFailDeps = makeDeps({
                getOrConnect: jest.fn().mockRejectedValue(new Error('refused')),
            });

            const noBindingResult = await resolveWorkspaceAndCdp(channel, noBindingDeps);
            const cdpFailResult = await resolveWorkspaceAndCdp(channel, cdpFailDeps);

            expect(noBindingResult.ok).toBe(false);
            expect(cdpFailResult.ok).toBe(false);
            if (!noBindingResult.ok && !cdpFailResult.ok) {
                expect(noBindingResult.message).not.toBe(cdpFailResult.message);
            }
        });
    });
});
