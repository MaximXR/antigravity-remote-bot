import { logger } from '../utils/logger';
import { CDP_PORTS } from '../utils/cdpPorts';
import { getAntigravityCdpHint, getAntigravityCliPath } from '../utils/pathUtils';
import * as http from 'http';
import { spawn } from 'child_process';

/**
 * Check if CDP responds on the specified port.
 */
function checkPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(Array.isArray(parsed));
                } catch {
                    resolve(false);
                }
            });
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

/**
 * Check if Antigravity is running with CDP ports.
 * If not running, output a warning log (no auto-start or restart).
 *
 * Called during Bot initialization.
 */
export async function ensureAntigravityRunning(): Promise<void> {
    logger.debug('[AntigravityLauncher] Checking CDP ports...');

    const results = await Promise.all(CDP_PORTS.map((port) => checkPort(port)));
    const foundIndex = results.indexOf(true);
    if (foundIndex !== -1) {
        logger.debug(`[AntigravityLauncher] OK — Port ${CDP_PORTS[foundIndex]} responding`);
        return;
    }

    logger.info('[AntigravityLauncher] Antigravity CDP ports are not responding. Launching default Antigravity IDE...');
    try {
        const antigravityCli = getAntigravityCliPath();
        const args = ['--remote-debugging-port=9223'];
        logger.debug(`[AntigravityLauncher] Spawning IDE: ${antigravityCli} ${args.join(' ')}`);
        const child = spawn(antigravityCli, args, {
            detached: true,
            stdio: 'ignore',
            shell: process.platform === 'win32'
        });
        child.unref();

        // Wait briefly (e.g. 3 seconds) for the IDE to launch and bind port
        await new Promise((resolve) => setTimeout(resolve, 3000));
    } catch (e: any) {
        logger.error(`[AntigravityLauncher] Failed to auto-launch Antigravity IDE: ${e?.message || e}`);
    }

    logger.warn('');
    logger.warn('='.repeat(70));
    logger.warn('  Antigravity CDP ports were not responding. Attempted launch.');
    logger.warn('');
    logger.warn('  If it did not launch, please open it manually:');
    logger.warn('    remoat open');
    logger.warn('');
    logger.warn('  Or manually:');
    logger.warn(`    ${getAntigravityCdpHint(9222)}`);
    logger.warn('');
    logger.warn('  The bot will auto-connect once Antigravity is running.');
    logger.warn('='.repeat(70));
    logger.warn('');
}
