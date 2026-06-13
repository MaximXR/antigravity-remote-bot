import { EventEmitter } from 'events';

import { logger } from '../utils/logger';
import { extractProjectNameFromPath } from '../utils/pathUtils';
import { CdpService, CdpServiceOptions } from './cdpService';
import { ApprovalDetector } from './approvalDetector';
import { ErrorPopupDetector } from './errorPopupDetector';
import { PlanningDetector } from './planningDetector';
import { UserMessageDetector } from './userMessageDetector';
import { QuestionDetector } from './questionDetector';

/**
 * Pool that manages independent CdpService instances per workspace.
 *
 * Each workspace owns its own WebSocket / contexts / pendingCalls, so
 * switching to workspace B while workspace A's ResponseMonitor is polling
 * does not destroy A's WebSocket.
 *
 * Emits workspace lifecycle events:
 * - `workspace:disconnected` (projectName: string)
 * - `workspace:reconnected` (projectName: string)
 * - `workspace:reconnectFailed` (projectName: string)
 */
export class CdpConnectionPool extends EventEmitter {
    private readonly connections = new Map<string, CdpService>();
    private readonly approvalDetectors = new Map<string, ApprovalDetector>();
    private readonly errorPopupDetectors = new Map<string, ErrorPopupDetector>();
    private readonly planningDetectors = new Map<string, PlanningDetector>();
    private readonly userMessageDetectors = new Map<string, UserMessageDetector>();
    private readonly questionDetectors = new Map<string, QuestionDetector>();
    private readonly connectingPromises = new Map<string, Promise<CdpService>>();
    private readonly cdpOptions: CdpServiceOptions;

    constructor(cdpOptions: CdpServiceOptions = {}) {
        super();
        this.cdpOptions = cdpOptions;
    }

    /**
     * Get a CdpService for the given workspace path.
     * Creates a new connection and caches it if not already connected.
     * Prevents concurrent connections via Promise locking.
     *
     * @param workspacePath Full path of the workspace
     * @returns Connected CdpService
     */
    async getOrConnect(workspacePath: string, openInNewWindow: boolean = false, targetPort?: number, allowLaunch: boolean = true): Promise<CdpService> {
        const projectName = this.extractProjectName(workspacePath);

        // Return existing connection if available
        const existing = this.connections.get(projectName);
        if (existing) {
            if (existing.isConnected()) {
                try {
                    // Re-validate that the still-open window is actually bound to this workspace.
                    await existing.discoverAndConnectForWorkspace(workspacePath, false, openInNewWindow, targetPort, allowLaunch);
                    return existing;
                } catch {
                    // Connection dropped during re-validation; close WebSocket and clean up
                    existing.disconnect().catch(() => {});
                    this.connections.delete(projectName);
                }
            } else {
                // Stale disconnected entry (e.g. reconnect was disabled) — clean up
                this.connections.delete(projectName);
            }
        }

        // Wait for the pending connection promise if one exists (prevents concurrent connections)
        const pending = this.connectingPromises.get(projectName);
        if (pending) {
            return pending;
        }

        // Start a new connection
        const connectPromise = this.createAndConnect(workspacePath, projectName, openInNewWindow, targetPort, allowLaunch);
        this.connectingPromises.set(projectName, connectPromise);

        try {
            const cdp = await connectPromise;
            return cdp;
        } finally {
            this.connectingPromises.delete(projectName);
        }
    }

    /**
     * Get a connected CdpService (read-only).
     * Returns null if not connected.
     */
    getConnected(projectName: string): CdpService | null {
        const cdp = this.connections.get(projectName);
        if (cdp && cdp.isConnected()) {
            return cdp;
        }
        return null;
    }

    /**
     * Get the workspace path for a connected service by its WebSocket URL.
     */
    getWorkspacePathByWebSocketUrl(wsUrl: string): string | null {
        for (const cdp of this.connections.values()) {
            if (cdp.isConnected() && cdp.getTargetUrl() === wsUrl) {
                return cdp.getCurrentWorkspacePath();
            }
        }
        return null;
    }

    /**
     * Get a connected CdpService by its WebSocket URL.
     */
    getConnectedByWebSocketUrl(wsUrl: string): CdpService | null {
        for (const cdp of this.connections.values()) {
            if (cdp.isConnected() && cdp.getTargetUrl() === wsUrl) {
                return cdp;
            }
        }
        return null;
    }


    /**
     * Pause Planning, ErrorPopup, Question and Approval detectors during AI generation to reduce CPU load.
     */
    pauseDetectors(projectName: string): void {
        const planning = this.planningDetectors.get(projectName);
        if (planning) {
            planning.pause();
        }

        const errorPopup = this.errorPopupDetectors.get(projectName);
        if (errorPopup) {
            errorPopup.pause();
        }

        const question = this.questionDetectors.get(projectName);
        if (question) {
            question.pause();
        }

        const approval = this.approvalDetectors.get(projectName);
        if (approval) {
            approval.pause();
        }

        logger.debug(`[CdpConnectionPool] Paused Planning, ErrorPopup, Question and Approval detectors for "${projectName}"`);
    }

    /**
     * Resume Planning, ErrorPopup, Question and Approval detectors after AI generation finishes.
     */
    resumeDetectors(projectName: string): void {
        const errorPopup = this.errorPopupDetectors.get(projectName);
        if (errorPopup) {
            errorPopup.resume();
        }

        const question = this.questionDetectors.get(projectName);
        if (question) {
            question.resume();
        }

        const approval = this.approvalDetectors.get(projectName);
        if (approval) {
            approval.resume();
        }

        logger.debug(`[CdpConnectionPool] Resumed Planning, ErrorPopup, Question and Approval detectors for "${projectName}"`);
    }

    /**
     * Disconnect the specified workspace.
     */
    disconnectWorkspace(projectName: string): void {
        const cdp = this.connections.get(projectName);
        if (cdp) {
            cdp.disconnect().catch((err) => {
                logger.error(`[CdpConnectionPool] Error while disconnecting ${projectName}:`, err);
            });
            this.connections.delete(projectName);
        }

        const detector = this.approvalDetectors.get(projectName);
        if (detector) {
            detector.stop();
            this.approvalDetectors.delete(projectName);
        }

        const errorPopupDetector = this.errorPopupDetectors.get(projectName);
        if (errorPopupDetector) {
            errorPopupDetector.stop();
            this.errorPopupDetectors.delete(projectName);
        }

        const planningDetector = this.planningDetectors.get(projectName);
        if (planningDetector) {
            planningDetector.stop();
            this.planningDetectors.delete(projectName);
        }

        const userMsgDetector = this.userMessageDetectors.get(projectName);
        if (userMsgDetector) {
            userMsgDetector.stop();
            this.userMessageDetectors.delete(projectName);
        }

        const questionDetector = this.questionDetectors.get(projectName);
        if (questionDetector) {
            questionDetector.stop();
            this.questionDetectors.delete(projectName);
        }
    }

    /**
     * Completely close the Antigravity instance for the specified workspace via CDP.
     */
    async closeBrowserWorkspace(projectName: string): Promise<void> {
        const cdp = this.connections.get(projectName);
        if (cdp) {
            try {
                await cdp.closeBrowserTarget();
            } catch (err) {
                logger.error(`[CdpConnectionPool] Error while closing browser for ${projectName}:`, err);
            }
        }
        this.disconnectWorkspace(projectName);
    }

    /**
     * Disconnect all workspace connections.
     */
    disconnectAll(): void {
        for (const projectName of [...this.connections.keys()]) {
            this.disconnectWorkspace(projectName);
        }
    }

    /**
     * Register an approval detector for a workspace.
     */
    registerApprovalDetector(projectName: string, detector: ApprovalDetector): void {
        // Stop existing detector
        const existing = this.approvalDetectors.get(projectName);
        if (existing && existing.isActive()) {
            existing.stop();
        }
        this.approvalDetectors.set(projectName, detector);
    }

    /**
     * Get the approval detector for a workspace.
     */
    getApprovalDetector(projectName: string): ApprovalDetector | undefined {
        const exact = this.approvalDetectors.get(projectName);
        if (exact) return exact;
        for (const [name, detector] of this.approvalDetectors.entries()) {
            if (name.startsWith(projectName) || projectName.startsWith(name)) {
                return detector;
            }
        }
        return undefined;
    }

    /**
     * Register an error popup detector for a workspace.
     */
    registerErrorPopupDetector(projectName: string, detector: ErrorPopupDetector): void {
        // Stop existing detector
        const existing = this.errorPopupDetectors.get(projectName);
        if (existing && existing.isActive()) {
            existing.stop();
        }
        this.errorPopupDetectors.set(projectName, detector);
    }

    /**
     * Get the error popup detector for a workspace.
     */
    getErrorPopupDetector(projectName: string): ErrorPopupDetector | undefined {
        const exact = this.errorPopupDetectors.get(projectName);
        if (exact) return exact;
        for (const [name, detector] of this.errorPopupDetectors.entries()) {
            if (name.startsWith(projectName) || projectName.startsWith(name)) {
                return detector;
            }
        }
        return undefined;
    }

    /**
     * Register a planning detector for a workspace.
     */
    registerPlanningDetector(projectName: string, detector: PlanningDetector): void {
        // Stop existing detector
        const existing = this.planningDetectors.get(projectName);
        if (existing && existing.isActive()) {
            existing.stop();
        }
        this.planningDetectors.set(projectName, detector);
    }

    /**
     * Get the planning detector for a workspace.
     */
    getPlanningDetector(projectName: string): PlanningDetector | undefined {
        const exact = this.planningDetectors.get(projectName);
        if (exact) return exact;
        for (const [name, detector] of this.planningDetectors.entries()) {
            if (name.startsWith(projectName) || projectName.startsWith(name)) {
                return detector;
            }
        }
        return undefined;
    }

    /**
     * Register a user message detector for a workspace.
     */
    registerUserMessageDetector(projectName: string, detector: UserMessageDetector): void {
        const existing = this.userMessageDetectors.get(projectName);
        if (existing && existing.isActive()) {
            existing.stop();
        }
        this.userMessageDetectors.set(projectName, detector);
    }

    /**
     * Get the user message detector for a workspace.
     */
    getUserMessageDetector(projectName: string): UserMessageDetector | undefined {
        return this.userMessageDetectors.get(projectName);
    }

    /**
     * Register a question detector for a workspace.
     */
    registerQuestionDetector(projectName: string, detector: QuestionDetector): void {
        const existing = this.questionDetectors.get(projectName);
        if (existing && existing.isActive()) {
            existing.stop();
        }
        this.questionDetectors.set(projectName, detector);
    }

    /**
     * Get the question detector for a workspace.
     */
    getQuestionDetector(projectName: string): QuestionDetector | undefined {
        const exact = this.questionDetectors.get(projectName);
        if (exact) return exact;
        for (const [name, detector] of this.questionDetectors.entries()) {
            if (name.startsWith(projectName) || projectName.startsWith(name)) {
                return detector;
            }
        }
        return undefined;
    }

    /**
     * Return a list of workspace names with active connections.
     */
    getActiveWorkspaceNames(): string[] {
        const active: string[] = [];
        for (const [name, cdp] of this.connections) {
            if (cdp.isConnected()) {
                active.push(name);
            }
        }
        return active;
    }

    /**
     * Extract the project name from a workspace path.
     */
    extractProjectName(workspacePath: string): string {
        return extractProjectNameFromPath(workspacePath) || workspacePath;
    }

    /**
     * Create a new CdpService and connect to the workspace.
     */
    private async createAndConnect(
        workspacePath: string,
        projectName: string,
        openInNewWindow: boolean = false,
        targetPort?: number,
        allowLaunch: boolean = true
    ): Promise<CdpService> {
        // Disconnect old connection if exists
        const old = this.connections.get(projectName);
        if (old) {
            await old.disconnect().catch(() => {});
            this.connections.delete(projectName);
        }

        const cdp = new CdpService({
            ...this.cdpOptions,
            isWebSocketUrlOccupied: (url: string) => {
                for (const [name, conn] of this.connections.entries()) {
                    if (name !== projectName && conn.isConnected() && conn.getTargetUrl() === url) {
                        return true;
                    }
                }
                return false;
            }
        });

        // Auto-cleanup on disconnect
        cdp.on('disconnected', () => {
            logger.error(`[CdpConnectionPool] Workspace "${projectName}" disconnected`);
            this.emit('workspace:disconnected', projectName);
            // Only remove from Map when reconnection fails
            // (CdpService attempts reconnection internally, so we don't remove here)
        });

        cdp.on('reconnected', () => {
            logger.info(`[CdpConnectionPool] Workspace "${projectName}" reconnected`);
            this.emit('workspace:reconnected', projectName);
        });

        cdp.on('response-monitor:start', () => {
            this.pauseDetectors(projectName);
        });

        cdp.on('response-monitor:stop', () => {
            this.resumeDetectors(projectName);
        });

        cdp.on('reconnectFailed', () => {
            logger.error(`[CdpConnectionPool] Reconnection failed for workspace "${projectName}". Removing from pool`);
            this.emit('workspace:reconnectFailed', projectName);
            this.disconnectWorkspace(projectName);
        });

        // Connect to the workspace
        await cdp.discoverAndConnectForWorkspace(workspacePath, false, openInNewWindow, targetPort, allowLaunch);
        this.connections.set(projectName, cdp);

        return cdp;
    }
}
