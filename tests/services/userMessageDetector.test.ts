import { UserMessageDetector, UserMessageInfo } from '../../src/services/userMessageDetector';
import { CdpService } from '../../src/services/cdpService';
import Database from 'better-sqlite3';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

/** Advance fake timers and flush microtasks */
async function tick(ms: number): Promise<void> {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
}

describe('UserMessageDetector', () => {
    let mockCdpService: jest.Mocked<CdpService>;

    beforeEach(() => {
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        mockCdpService.getPrimaryContextId = jest.fn().mockReturnValue(42);
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('first poll primes existing DOM state without firing callback', async () => {
        const onUserMessage = jest.fn();
        mockCdpService.call.mockResolvedValue({
            result: { value: { text: 'Existing message' } },
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();

        // First poll — priming, should NOT fire callback
        await tick(100);
        expect(onUserMessage).not.toHaveBeenCalled();

        // Second poll — same message, still no callback (duplicate)
        await tick(100);
        expect(onUserMessage).not.toHaveBeenCalled();

        await detector.stop();
    });

    it('detects a new user message after priming', async () => {
        const onUserMessage = jest.fn();
        let callCount = 0;
        mockCdpService.call.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                // Priming poll: existing message in DOM
                return { result: { value: { text: 'Old message' } } };
            }
            return { result: { value: { text: 'Hello from PC' } } };
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();
        expect(detector.isActive()).toBe(true);

        // First poll — priming
        await tick(100);
        expect(onUserMessage).not.toHaveBeenCalled();

        // Second poll — new message detected
        await tick(100);
        expect(onUserMessage).toHaveBeenCalledWith({ text: 'Hello from PC' });

        await detector.stop();
        expect(detector.isActive()).toBe(false);
    });

    it('primes with empty DOM and detects first real message', async () => {
        const onUserMessage = jest.fn();
        let callCount = 0;
        mockCdpService.call.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return { result: { value: null } }; // empty DOM
            }
            return { result: { value: { text: 'First message' } } };
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();

        // First poll — priming with empty DOM
        await tick(100);
        expect(onUserMessage).not.toHaveBeenCalled();

        // Second poll — first real message
        await tick(100);
        expect(onUserMessage).toHaveBeenCalledWith({ text: 'First message' });

        await detector.stop();
    });

    it('does not call onUserMessage for duplicate messages', async () => {
        const onUserMessage = jest.fn();
        let callCount = 0;
        mockCdpService.call.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return { result: { value: null } }; // priming: empty
            }
            return { result: { value: { text: 'Same message' } } };
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();

        // Priming poll
        await tick(100);

        // First real poll
        await tick(100);

        // Second real poll — same message
        await tick(100);

        expect(onUserMessage).toHaveBeenCalledTimes(1);

        await detector.stop();
    });

    it('skips messages matching echo hashes', async () => {
        const onUserMessage = jest.fn();
        let callCount = 0;
        mockCdpService.call.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return { result: { value: null } }; // priming: empty
            }
            return { result: { value: { text: 'Echoed message' } } };
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        // Register the echo hash before starting
        detector.addEchoHash('Echoed message');
        detector.start();

        // Priming poll
        await tick(100);

        // Real poll — echo, should be skipped
        await tick(100);

        expect(onUserMessage).not.toHaveBeenCalled();

        await detector.stop();
    });

    it('handles CDP errors gracefully', async () => {
        const onUserMessage = jest.fn();
        mockCdpService.call.mockRejectedValue(new Error('CDP timeout'));

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();

        await tick(100);

        // Should not throw, detector should remain active
        expect(detector.isActive()).toBe(true);
        expect(onUserMessage).not.toHaveBeenCalled();

        await detector.stop();
    });

    it('handles null result from CDP', async () => {
        const onUserMessage = jest.fn();
        mockCdpService.call.mockResolvedValue({
            result: { value: null },
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();

        await tick(100);

        expect(onUserMessage).not.toHaveBeenCalled();

        await detector.stop();
    });

    it('detects new message after different message', async () => {
        const onUserMessage = jest.fn();
        let callCount = 0;
        mockCdpService.call.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return { result: { value: null } }; // priming: empty
            }
            if (callCount === 2) {
                return { result: { value: { text: 'First message' } } };
            }
            return { result: { value: { text: 'Second message' } } };
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();

        // Priming poll
        await tick(100);

        // First real message
        await tick(100);

        // Second real message — different
        await tick(100);

        expect(onUserMessage).toHaveBeenCalledTimes(2);
        expect(onUserMessage).toHaveBeenNthCalledWith(1, { text: 'First message' });
        expect(onUserMessage).toHaveBeenNthCalledWith(2, { text: 'Second message' });

        await detector.stop();
    });

    it('start() is idempotent', () => {
        const onUserMessage = jest.fn();
        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();
        detector.start(); // should not throw or create double polling

        expect(detector.isActive()).toBe(true);

        detector.stop();
    });

    it('seenHashes prevents re-detection of old messages after a different message appears', async () => {
        const onUserMessage = jest.fn();
        let callCount = 0;
        mockCdpService.call.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return { result: { value: null } }; // priming: empty
            }
            if (callCount === 2) {
                return { result: { value: { text: 'Message A' } } };
            }
            if (callCount === 3) {
                return { result: { value: { text: 'Message B' } } };
            }
            // Poll 4: DOM reverts back to Message A (e.g., transient DOM state)
            return { result: { value: { text: 'Message A' } } };
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();

        // Priming poll
        await tick(100);

        // Poll: Message A — detected
        await tick(100);

        // Poll: Message B — detected
        await tick(100);

        // Poll: Message A again — should be skipped by seenHashes
        await tick(100);

        expect(onUserMessage).toHaveBeenCalledTimes(2);
        expect(onUserMessage).toHaveBeenNthCalledWith(1, { text: 'Message A' });
        expect(onUserMessage).toHaveBeenNthCalledWith(2, { text: 'Message B' });

        await detector.stop();
    });

    it('seenHashes are cleared on restart', async () => {
        const onUserMessage = jest.fn();
        let callCount = 0;
        mockCdpService.call.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return { result: { value: null } }; // priming: empty (session 1)
            }
            if (callCount === 2) {
                return { result: { value: { text: 'Restart message' } } };
            }
            if (callCount === 3) {
                return { result: { value: null } }; // priming: empty (session 2)
            }
            return { result: { value: { text: 'Restart message' } } };
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        // First session
        detector.start();
        await tick(100); // priming
        await tick(100); // detect
        expect(onUserMessage).toHaveBeenCalledTimes(1);
        detector.stop();

        // Second session — same message should be detected again after restart
        detector.start();
        await tick(100); // priming
        await tick(100); // detect
        expect(onUserMessage).toHaveBeenCalledTimes(2);

        await detector.stop();
    });

    it('dynamic priming works when chat title changes', async () => {
        const onUserMessage = jest.fn();
        let queryCount = 0;
        mockCdpService.call.mockImplementation(async (method, params) => {
            if (method === 'Runtime.evaluate') {
                const expr = params?.expression;
                if (typeof expr === 'string' && !expr.includes('STOP_BUTTON') && !expr.includes('isGenerating')) {
                    queryCount++;
                    if (queryCount === 1) {
                        // priming: title = 'Agent'
                        return { result: { value: { text: 'Hello', chatTitle: 'Agent', index: 1, timestamp: '10:00' } } };
                    }
                    if (queryCount === 2) {
                        // Same message text and index, but title changed to 'New Title'
                        return { result: { value: { text: 'Hello', chatTitle: 'New Title', index: 1, timestamp: '10:00' } } };
                    }
                    // User types a new message in the renamed chat
                    return { result: { value: { text: 'How are you', chatTitle: 'New Title', index: 2, timestamp: '10:01' } } };
                }
                // Stop button check
                return { result: { value: { isGenerating: false } } };
            }
            return { result: { value: null } };
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();

        // 1. Priming poll (sees 'Hello' in 'Agent' chat)
        await tick(100);
        expect(onUserMessage).not.toHaveBeenCalled();

        // 2. Poll 2 (sees title changed to 'New Title'). This should trigger priming because of title change.
        // So it should NOT trigger callback.
        await tick(100);
        expect(onUserMessage).not.toHaveBeenCalled();

        // 3. Poll 3 (sees new message 'How are you' at index 2). This should trigger callback.
        await tick(100);
        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'How are you' }));

        await detector.stop();
    });

    it('allows repeating the same message text at different index/timestamp', async () => {
        const onUserMessage = jest.fn();
        let queryCount = 0;
        mockCdpService.call.mockImplementation(async (method, params) => {
            if (method === 'Runtime.evaluate') {
                const expr = params?.expression;
                if (typeof expr === 'string' && !expr.includes('STOP_BUTTON') && !expr.includes('isGenerating')) {
                    queryCount++;
                    if (queryCount === 1) {
                        // priming: empty DOM
                        return { result: { value: null } };
                    }
                    if (queryCount === 2) {
                        // message at index 1
                        return { result: { value: { text: 'repeat me', chatTitle: 'Agent', index: 1, timestamp: '10:00' } } };
                    }
                    // same message at index 2
                    return { result: { value: { text: 'repeat me', chatTitle: 'Agent', index: 2, timestamp: '10:01' } } };
                }
                return { result: { value: { isGenerating: false } } };
            }
            return { result: { value: null } };
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();

        await tick(100); // priming
        await tick(100); // index 1 message detected
        expect(onUserMessage).toHaveBeenCalledTimes(1);

        await tick(100); // index 2 message detected (even though text is the same!)
        expect(onUserMessage).toHaveBeenCalledTimes(2);

        await detector.stop();
    });

    it('database cleanup keeps hashes within 24h and deletes older', () => {
        const db = new Database(':memory:');
        db.exec(`
            CREATE TABLE seen_user_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            )
        `);

        // Insert a fresh hash and a stale hash (older than 24h)
        db.prepare("INSERT INTO seen_user_messages (message_hash, created_at) VALUES (?, datetime('now', '-25 hours'))").run('stale_hash');
        db.prepare("INSERT INTO seen_user_messages (message_hash, created_at) VALUES (?, datetime('now', '-1 hour'))").run('fresh_hash');

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage: jest.fn(),
            db
        });

        // The constructor should trigger the 24-hour cleanup
        const rows = db.prepare('SELECT message_hash FROM seen_user_messages').all() as { message_hash: string }[];
        expect(rows.map(r => r.message_hash)).toContain('fresh_hash');
        expect(rows.map(r => r.message_hash)).not.toContain('stale_hash');
    });

    it('handles message revert/rollback gracefully without triggering callback and allows subsequent messages', async () => {
        const onUserMessage = jest.fn();
        let queryCount = 0;
        mockCdpService.call.mockImplementation(async (method, params) => {
            if (method === 'Runtime.evaluate') {
                const expr = params?.expression;
                if (typeof expr === 'string' && !expr.includes('STOP_BUTTON') && !expr.includes('isGenerating')) {
                    queryCount++;
                    if (queryCount === 1) {
                        // priming: starts with message at index 1
                        return { result: { value: { text: 'Hello', chatTitle: 'Agent', index: 1, timestamp: '10:00' } } };
                    }
                    if (queryCount === 2) {
                        // message at index 2
                        return { result: { value: { text: 'How are you', chatTitle: 'Agent', index: 2, timestamp: '10:01' } } };
                    }
                    if (queryCount === 3) {
                        // revert/undo: steps decrease back to index 1 (text is 'Hello')
                        return { result: { value: { text: 'Hello', chatTitle: 'Agent', index: 1, timestamp: '10:00' } } };
                    }
                    // user types the same message or a new message at index 2 again
                    return { result: { value: { text: 'How are you', chatTitle: 'Agent', index: 2, timestamp: '10:02' } } };
                }
                return { result: { value: { isGenerating: false } } };
            }
            return { result: { value: null } };
        });

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
        });

        detector.start();

        await tick(100); // 1. priming (index 1) - no callback
        expect(onUserMessage).not.toHaveBeenCalled();

        await tick(100); // 2. index 2 detected - fires callback
        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'How are you', index: 2 }));

        await tick(100); // 3. revert detected (index 2 -> index 1) - should NOT fire callback
        expect(onUserMessage).toHaveBeenCalledTimes(1); // count remains 1

        await tick(100); // 4. same/new message at index 2 again - fires callback because of index count and new timestamp/index state
        expect(onUserMessage).toHaveBeenCalledTimes(2);
        expect(onUserMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'How are you', index: 2 }));

        await detector.stop();
    });

    it('restricts database lookup to priming phase', async () => {
        const db = new Database(':memory:');
        db.exec(`
            CREATE TABLE seen_user_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);

        const onUserMessage = jest.fn();
        let queryCount = 0;
        mockCdpService.call.mockImplementation(async (method, params) => {
            if (method === 'Runtime.evaluate') {
                const expr = params?.expression;
                if (typeof expr === 'string' && !expr.includes('STOP_BUTTON') && !expr.includes('isGenerating')) {
                    queryCount++;
                    if (queryCount === 1) {
                        // priming: empty DOM
                        return { result: { value: null } };
                    }
                    // normal poll: message at index 1
                    return { result: { value: { text: 'Hello DB Test', chatTitle: 'Agent', index: 1, timestamp: '10:00' } } };
                }
                return { result: { value: { isGenerating: false } } };
            }
            return { result: { value: null } };
        });

        // Insert the hash of "Hello DB Test" into the DB.
        // If the detector checked the DB during normal polling, it would skip it.
        // But since it's normal polling, it shouldn't check DB and should trigger the callback.
        const crypto = require('node:crypto');
        const dbHash = crypto.createHash('sha256')
            .update('Agent_Hello DB Test_1_10:00')
            .digest('hex')
            .slice(0, 16);
        db.prepare('INSERT INTO seen_user_messages (message_hash) VALUES (?)').run(dbHash);

        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
            db
        });

        detector.start();

        await tick(100); // priming
        expect(onUserMessage).not.toHaveBeenCalled();

        await tick(100); // normal poll: should trigger callback even though hash is in DB
        expect(onUserMessage).toHaveBeenCalledTimes(1);

        await detector.stop();
    });
});
