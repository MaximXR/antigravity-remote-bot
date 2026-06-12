import { QuestionDetector, QuestionInfo } from '../../src/services/questionDetector';
import { CdpService } from '../../src/services/cdpService';

// Mock CdpService
jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('QuestionDetector - interactive question detection and remote execution', () => {
    let detector: QuestionDetector;
    let mockCdpService: jest.Mocked<CdpService>;

    beforeEach(() => {
        jest.useFakeTimers();
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        mockCdpService.getPrimaryContextId = jest.fn().mockReturnValue(42);
        jest.clearAllMocks();
    });

    afterEach(async () => {
        if (detector) {
            await detector.stop();
        }
        jest.useRealTimers();
    });

    function makeQuestionInfo(overrides: Partial<QuestionInfo> = {}): QuestionInfo {
        return {
            question: 'Выберите порт для запуска',
            options: ['8080', '3000', 'Другой порт...'],
            isMultiSelect: false,
            key: 'port::8080|3000|Другой порт...::false',
            ...overrides,
        };
    }

    it('calls the onQuestionRequired callback when a question is detected', async () => {
        const onQuestionRequired = jest.fn();
        const mockInfo = makeQuestionInfo();

        mockCdpService.call.mockResolvedValue({
            result: { value: mockInfo }
        });

        detector = new QuestionDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onQuestionRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(onQuestionRequired).toHaveBeenCalledTimes(1);
        expect(onQuestionRequired).toHaveBeenCalledWith(
            expect.objectContaining({
                question: 'Выберите порт для запуска',
                options: expect.arrayContaining(['8080', '3000', 'Другой порт...']),
            })
        );
    });

    it('does not call the callback when no question exists', async () => {
        const onQuestionRequired = jest.fn();
        mockCdpService.call.mockResolvedValue({ result: { value: null } });

        detector = new QuestionDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onQuestionRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(onQuestionRequired).not.toHaveBeenCalled();
    });

    it('does not call the callback multiple times when the same question is detected consecutively', async () => {
        const onQuestionRequired = jest.fn();
        const mockInfo = makeQuestionInfo();

        mockCdpService.call.mockResolvedValue({
            result: { value: mockInfo }
        });

        detector = new QuestionDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onQuestionRequired,
        });
        detector.start();

        // 3 polling cycles
        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);

        expect(onQuestionRequired).toHaveBeenCalledTimes(1);
    });

    it('calls onResolved callback when the question disappears for consecutive ticks', async () => {
        const onQuestionRequired = jest.fn();
        const onResolved = jest.fn();
        const mockInfo = makeQuestionInfo();

        // First returns a question, then null
        mockCdpService.call
            .mockResolvedValueOnce({ result: { value: mockInfo } })
            .mockResolvedValue({ result: { value: null } });

        detector = new QuestionDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onQuestionRequired,
            onResolved,
        });
        detector.start();

        // 1st tick: Question detected
        await jest.advanceTimersByTimeAsync(500);
        expect(onQuestionRequired).toHaveBeenCalledTimes(1);
        expect(onResolved).not.toHaveBeenCalled();

        // 2nd tick: Question disappeared (1st consecutive null)
        await jest.advanceTimersByTimeAsync(500);
        expect(onResolved).not.toHaveBeenCalled();

        // 3rd tick: Question disappeared (2nd consecutive null -> resolved)
        await jest.advanceTimersByTimeAsync(500);
        expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it('executes option click script via CDP when clickOption() is called', async () => {
        mockCdpService.call.mockResolvedValue({
            result: { value: { ok: true } }
        });

        detector = new QuestionDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onQuestionRequired: jest.fn(),
        });

        const result = await detector.clickOption(1);

        expect(result).toBe(true);
        expect(mockCdpService.call).toHaveBeenCalledWith(
            'Runtime.evaluate',
            expect.objectContaining({
                expression: expect.stringContaining('cleanOptionElements'),
                returnByValue: true,
                contextId: 42,
            })
        );
    });

    it('executes custom text submit script via CDP when submitTextAnswer() is called', async () => {
        mockCdpService.call.mockResolvedValue({
            result: { value: { ok: true } }
        });

        detector = new QuestionDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onQuestionRequired: jest.fn(),
        });

        const result = await detector.submitTextAnswer(2, 'custom-value');

        expect(result).toBe(true);
        expect(mockCdpService.call).toHaveBeenCalledWith(
            'Runtime.evaluate',
            expect.objectContaining({
                expression: expect.stringContaining('inputEl.value ='),
                returnByValue: true,
                contextId: 42,
            })
        );
    });

    it('executes skip script via CDP when clickSkip() is called', async () => {
        mockCdpService.call.mockResolvedValue({
            result: { value: { ok: true } }
        });

        detector = new QuestionDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onQuestionRequired: jest.fn(),
        });

        const result = await detector.clickSkip();

        expect(result).toBe(true);
        expect(mockCdpService.call).toHaveBeenCalledWith(
            'Runtime.evaluate',
            expect.objectContaining({
                expression: expect.stringContaining('skipBtn'),
                returnByValue: true,
                contextId: 42,
            })
        );
    });

    it('stops polling when pause() is called and resumes when resume() is called', async () => {
        const onQuestionRequired = jest.fn();
        mockCdpService.call.mockResolvedValue({
            result: { value: makeQuestionInfo() }
        });

        detector = new QuestionDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onQuestionRequired,
        });
        detector.start();

        // 1st tick: Detected
        await jest.advanceTimersByTimeAsync(500);
        expect(onQuestionRequired).toHaveBeenCalledTimes(1);

        detector.pause();
        jest.clearAllMocks();

        // 2nd tick while paused: Nothing called
        await jest.advanceTimersByTimeAsync(500);
        expect(mockCdpService.call).not.toHaveBeenCalled();

        detector.resume();
        // Resume triggers a poll right away, let's wait for microtasks/timers
        await jest.runOnlyPendingTimersAsync();
        expect(mockCdpService.call).toHaveBeenCalled();
    });
});
