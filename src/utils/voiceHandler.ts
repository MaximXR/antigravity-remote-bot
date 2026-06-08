import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
// @ts-ignore
import fetch from 'node-fetch';

import { logger } from './logger';

const TEMP_VOICE_DIR = path.join(os.tmpdir(), 'remoat-voice');

/**
 * Check whether Whisper transcription is available.
 * Returns null if ready, or a user-facing setup message if not.
 */
export function checkWhisperAvailability(): string | null {
    // 1. Check nodejs-whisper package
    try {
        require.resolve('nodejs-whisper');
    } catch {
        return (
            '🔇 Voice transcription is not set up.\n\n' +
            'To enable it, run:\n' +
            '  npm install nodejs-whisper ffmpeg-static\n' +
            '  npx nodejs-whisper download'
        );
    }

    // 2. Check whisper-cli binary
    const cppDir = path.join(
        path.dirname(require.resolve('nodejs-whisper/package.json')),
        'cpp', 'whisper.cpp', 'build', 'bin',
    );
    try {
        const binName = process.platform === 'win32' ? path.join('Release', 'whisper-cli.exe') : 'whisper-cli';
        const stat = require('fs').statSync(path.join(cppDir, binName));
        if (!stat.isFile()) throw new Error();
    } catch {
        return (
            '🔇 Whisper is installed but not compiled.\n\n' +
            'Run this to build it:\n' +
            '  cd node_modules/nodejs-whisper/cpp/whisper.cpp\n' +
            '  cmake -B build && cmake --build build --config Release\n\n' +
            'Requires cmake (brew install cmake / apt install cmake).'
        );
    }

    // 3. Check model file
    const modelsDir = path.join(
        path.dirname(require.resolve('nodejs-whisper/package.json')),
        'cpp', 'whisper.cpp', 'models'
    );
    try {
        const files = require('fs').readdirSync(modelsDir) as string[];
        if (!files.some((f: string) => f.includes('base.en'))) throw new Error();
    } catch {
        return (
            '🔇 Whisper model not downloaded.\n\n' +
            'Run this once to fetch the base.en model (~140 MB):\n' +
            '  npx nodejs-whisper download'
        );
    }

    return null;
}

export interface TelegramVoiceInfo {
    file_id: string;
    file_unique_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
}

/**
 * Download a voice message OGG file from the Telegram Bot API to a local temp directory.
 */
export async function downloadTelegramVoice(
    botApi: { getFile: (fileId: string) => Promise<any> },
    botToken: string,
    voice: TelegramVoiceInfo,
): Promise<string> {
    await fs.mkdir(TEMP_VOICE_DIR, { recursive: true });

    const file = await botApi.getFile(voice.file_id);
    const filePath = file.file_path;
    if (!filePath) {
        throw new Error('Telegram returned no file_path for voice message');
    }

    let url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    let init: any = {};
    const fallbackIpsRaw = process.env.TELEGRAM_FALLBACK_IPS || '';
    const fallbackIps = fallbackIpsRaw.split(',').map(ip => ip.trim()).filter(Boolean);
    if (fallbackIps.length > 0) {
        const ip = fallbackIps[0];
        url = `https://${ip}/file/bot${botToken}/${filePath}`;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const agent = new https.Agent({
            keepAlive: true,
            rejectUnauthorized: false,
            servername: 'api.telegram.org',
        });
        init = {
            agent,
            headers: {
                'Host': 'api.telegram.org',
            },
        };
    }
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error(`Voice download failed (status=${response.status})`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
        throw new Error('Voice download returned empty file');
    }

    const ext = path.extname(filePath) || '.ogg';
    const localPath = path.join(TEMP_VOICE_DIR, `${Date.now()}-${voice.file_unique_id}${ext}`);
    await fs.writeFile(localPath, bytes);

    logger.info(`[VoiceHandler] Downloaded voice message to ${localPath} (${bytes.length} bytes)`);
    return localPath;
}

/**
 * Transcribe a voice file using nodejs-whisper (whisper.cpp bindings).
 * Returns the trimmed transcript string, or null if transcription fails.
 */
export async function transcribeVoice(voicePath: string): Promise<string | null> {
    try {
        // Set FFMPEG_PATH from ffmpeg-static if not already set, so nodejs-whisper
        // can convert OGG→WAV without requiring a system ffmpeg install.
        if (!process.env.FFMPEG_PATH) {
            try {
                const ffmpegStatic = require('ffmpeg-static') as string;
                if (ffmpegStatic) {
                    process.env.FFMPEG_PATH = ffmpegStatic;
                }
            } catch {
                // ffmpeg-static not installed; rely on system ffmpeg
                logger.warn('[VoiceHandler] ffmpeg-static not found, relying on system ffmpeg');
            }
        }

        const { nodewhisper } = require('nodejs-whisper') as typeof import('nodejs-whisper');

        const result = await nodewhisper(voicePath, {
            modelName: 'base.en',
            autoDownloadModelName: 'base.en',
            removeWavFileAfterTranscription: true,
            whisperOptions: {
                outputInText: true,
                outputInSrt: false,
                outputInVtt: false,
                outputInCsv: false,
                outputInJson: false,
                wordTimestamps: false,
            },
        });

        const raw = typeof result === 'string'
            ? result.trim()
            : String(result ?? '').trim();

        // Strip Whisper timestamp prefixes like "[00:00:00.000 --> 00:00:02.000]"
        const transcript = raw
            .replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/g, '')
            .trim();

        if (!transcript) {
            logger.warn('[VoiceHandler] Whisper returned empty transcript');
            return null;
        }

        logger.info(`[VoiceHandler] Transcribed: "${transcript.slice(0, 100)}${transcript.length > 100 ? '...' : ''}"`);
        return transcript;
    } catch (error: any) {
        logger.error('[VoiceHandler] Transcription failed:', error?.message || error);
        return null;
    } finally {
        // Clean up the original voice file
        await fs.unlink(voicePath).catch(() => {});
    }
}
