import { CdpConnectionPool } from '../../src/services/cdpConnectionPool';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');

describe('CdpConnectionPool — bug fix coverage', () => {
    let pool: CdpConnectionPool;

    beforeEach(() => {
        pool = new CdpConnectionPool({ cdpCallTimeout: 5000 });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        pool.disconnectAll();
        jest.restoreAllMocks();
    });

    describe('disconnect stale connection on re-validation failure', () => {
        it('disconnects and removes the stale entry when re-validation throws', async () => {
            const mockCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn()
                    .mockResolvedValueOnce(true)        // initial connect succeeds
                    .mockRejectedValueOnce(new Error('tab closed')), // re-validation fails
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            const freshCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            let callCount = 0;
            (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => {
                callCount++;
                return (callCount === 1 ? mockCdp : freshCdp) as any;
            });

            // First connection succeeds
            const cdp1 = await pool.getOrConnect('/path/to/Project');
            expect(cdp1).toBe(mockCdp);

            // Second call: re-validation throws → should disconnect stale, create new
            const cdp2 = await pool.getOrConnect('/path/to/Project');

            // Bug fix: stale connection should have been disconnected
            expect(mockCdp.disconnect).toHaveBeenCalled();
            // New connection should be returned
            expect(cdp2).toBe(freshCdp);
        });

        it('cleans up disconnected entries without calling disconnect', async () => {
            const mockCdp = {
                // Returns false when checked on second getOrConnect (stale entry)
                isConnected: jest.fn().mockReturnValue(false),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            const freshCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            let callCount = 0;
            (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => {
                callCount++;
                return (callCount === 1 ? mockCdp : freshCdp) as any;
            });

            // First connect goes through createAndConnect (no isConnected check)
            await pool.getOrConnect('/path/to/Project');
            // Second call: existing found, isConnected()=false → stale, cleaned up → new connection
            const cdp2 = await pool.getOrConnect('/path/to/Project');

            // Stale disconnected entry should be replaced with fresh connection
            expect(cdp2).toBe(freshCdp);
            // disconnect() should NOT be called on stale entry (already disconnected)
            expect(mockCdp.disconnect).not.toHaveBeenCalled();
        });
    });

    describe('reconnectFailed uses disconnectWorkspace', () => {
        it('removes connection and stops detectors on reconnectFailed', async () => {
            const eventHandlers: Record<string, Function> = {};
            const mockCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn((event: string, handler: Function) => {
                    eventHandlers[event] = handler;
                }),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

            await pool.getOrConnect('/path/to/Project');

            // Register a detector
            const mockDetector = {
                isActive: jest.fn().mockReturnValue(true),
                stop: jest.fn(),
                start: jest.fn(),
            } as any;
            pool.registerApprovalDetector('Project', mockDetector);

            // Simulate reconnectFailed event
            expect(eventHandlers['reconnectFailed']).toBeDefined();
            eventHandlers['reconnectFailed']();

            // Bug fix: should use disconnectWorkspace which cleans up detectors too
            expect(mockCdp.disconnect).toHaveBeenCalled();
            expect(mockDetector.stop).toHaveBeenCalled();
            expect(pool.getConnected('Project')).toBeNull();
            expect(pool.getApprovalDetector('Project')).toBeUndefined();
        });

        it('registers disconnected event handler', async () => {
            const eventHandlers: Record<string, Function> = {};
            const mockCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn((event: string, handler: Function) => {
                    eventHandlers[event] = handler;
                }),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

            await pool.getOrConnect('/path/to/Project');

            expect(eventHandlers['disconnected']).toBeDefined();
            expect(eventHandlers['reconnectFailed']).toBeDefined();
        });
    });

    describe('prevent duplicate connection to the same WebSocket URL', () => {
        it('passes isWebSocketUrlOccupied callback that detects busy URLs', async () => {
            let optionsPassedA: any = null;
            let optionsPassedB: any = null;

            const mockCdpA = {
                isConnected: jest.fn().mockReturnValue(true),
                getTargetUrl: jest.fn().mockReturnValue('ws://127.0.0.1:9222/devtools/page/abc'),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            const mockCdpB = {
                isConnected: jest.fn().mockReturnValue(true),
                getTargetUrl: jest.fn().mockReturnValue('ws://127.0.0.1:9222/devtools/page/xyz'),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            let callCount = 0;
            (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation((options) => {
                callCount++;
                if (callCount === 1) {
                    optionsPassedA = options;
                    return mockCdpA as any;
                }
                optionsPassedB = options;
                return mockCdpB as any;
            });

            // Connect ProjectA
            await pool.getOrConnect('/path/to/ProjectA');
            // Connect ProjectB
            await pool.getOrConnect('/path/to/ProjectB');

            expect(optionsPassedA.isWebSocketUrlOccupied).toBeDefined();
            expect(optionsPassedB.isWebSocketUrlOccupied).toBeDefined();

            // Project A's callback: checks other connections. Project B is connected to xyz, Project A is abc.
            // So for Project A, checking URL of Project B (xyz) should return true because B is connected.
            expect(optionsPassedA.isWebSocketUrlOccupied('ws://127.0.0.1:9222/devtools/page/xyz')).toBe(true);

            // Checking Project A's own URL (abc) for Project A should return false (allows self reconnection)
            expect(optionsPassedA.isWebSocketUrlOccupied('ws://127.0.0.1:9222/devtools/page/abc')).toBe(false);

            // Checking a totally unused URL should return false
            expect(optionsPassedA.isWebSocketUrlOccupied('ws://127.0.0.1:9222/devtools/page/other')).toBe(false);

            // Project B's callback: checking Project A's URL (abc) should return true because A is connected.
            expect(optionsPassedB.isWebSocketUrlOccupied('ws://127.0.0.1:9222/devtools/page/abc')).toBe(true);
        });
    });
});

