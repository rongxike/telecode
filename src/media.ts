import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';

const SECRET_KEY = 'telecode.mediaApiKey';
const SECRET_PROVIDER = 'runware';

export interface MediaSettings {
    baseUrl: string;
    imageModel: string;
    videoModel: string;
}

export interface GeneratedMedia {
    kind: 'image' | 'video';
    /** Public URL, or a local file path when the provider returned base64 data. */
    url: string;
    prompt: string;
}

/** Artifacts waiting to be delivered to a Telegram chat. */
const pending = new Map<number, GeneratedMedia[]>();

let extensionContext: vscode.ExtensionContext | undefined;
let activeChat: () => number | null = () => null;

export function initMedia(context: vscode.ExtensionContext): void {
    extensionContext = context;
}

export function setActiveChatProvider(provider: () => number | null): void {
    activeChat = provider;
}

export function queueMedia(chatId: number, media: GeneratedMedia): void {
    const list = pending.get(chatId) ?? [];
    list.push(media);
    pending.set(chatId, list);
}

export function takeMedia(chatId: number): GeneratedMedia[] {
    const list = pending.get(chatId) ?? [];
    pending.delete(chatId);
    return list;
}

export function getMediaSettings(): MediaSettings | null {
    const config = vscode.workspace.getConfiguration('telecode');
    if (!config.get<boolean>('media.enabled', false)) {
        return null;
    }

    const baseUrl = (config.get<string>('media.baseUrl') || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
        return null;
    }

    return {
        baseUrl,
        imageModel: (config.get<string>('media.imageModel') || '').trim(),
        videoModel: (config.get<string>('media.videoModel') || '').trim()
    };
}

export async function getMediaApiKey(): Promise<string | undefined> {
    return extensionContext?.secrets.get(SECRET_KEY);
}

/** Command: store the media provider key in VS Code Secret Storage. */
export async function promptForMediaApiKey(): Promise<void> {
    if (!extensionContext) {
        return;
    }

    const existing = await getMediaApiKey();
    const settings = getMediaSettings();

    const key = await vscode.window.showInputBox({
        title: 'TeleCode: Configure Media API Key',
        prompt: settings
            ? `API key for ${settings.baseUrl} (stored in VS Code Secret Storage)`
            : 'Stored in VS Code Secret Storage. Enable telecode.media.enabled to use it.',
        password: true,
        ignoreFocusOut: true,
        placeHolder: existing ? 'A key is already stored - enter a new one to replace it' : 'Paste your provider API key'
    });

    if (!key?.trim()) {
        return;
    }

    await extensionContext.secrets.store(SECRET_KEY, key.trim());
    vscode.window.showInformationMessage(`Media API key saved (${SECRET_PROVIDER}) in VS Code Secret Storage.`);
}

export async function clearMediaApiKey(): Promise<void> {
    await extensionContext?.secrets.delete(SECRET_KEY);
}

interface RunwareTask {
    [key: string]: unknown;
}

async function runRunwareTask(settings: MediaSettings, task: RunwareTask): Promise<Array<Record<string, unknown>>> {
    const apiKey = await getMediaApiKey();
    if (!apiKey) {
        throw new Error('No media API key stored. Run "TeleCode: Configure Media API Key" in VS Code.');
    }

    const response = await fetch(settings.baseUrl, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`
        },
        // Runware accepts an array of tasks; authentication travels with the request.
        body: JSON.stringify([{ taskType: 'authentication', apiKey }, task])
    });

    const raw = await response.text();

    if (!response.ok) {
        throw new Error(`Media API ${response.status} ${response.statusText}: ${raw.slice(0, 500)}`);
    }

    let parsed: { data?: Array<Record<string, unknown>>; errors?: Array<{ message?: string }> };
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`Media API returned non-JSON: ${raw.slice(0, 300)}`);
    }

    if (parsed.errors && parsed.errors.length > 0) {
        throw new Error(parsed.errors.map((error) => error.message ?? 'unknown error').join('; '));
    }

    const data = parsed.data ?? [];
    if (data.length === 0) {
        throw new Error(`Media API returned no data: ${raw.slice(0, 300)}`);
    }

    return data;
}

async function saveBase64(kind: 'image' | 'video', base64: string): Promise<string> {
    const directory = path.join(os.tmpdir(), 'telecode-media');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${kind}-${randomUUID()}.${kind === 'image' ? 'jpg' : 'mp4'}`);
    await fs.writeFile(file, Buffer.from(base64, 'base64'));
    return file;
}

async function extractMedia(
    kind: 'image' | 'video',
    data: Array<Record<string, unknown>>,
    prompt: string
): Promise<GeneratedMedia> {
    const urlField = kind === 'image' ? 'imageURL' : 'videoURL';
    const base64Field = kind === 'image' ? 'imageBase64Data' : 'videoBase64Data';

    const withUrl = data.find((item) => typeof item[urlField] === 'string' && item[urlField]);
    if (withUrl) {
        return { kind, url: withUrl[urlField] as string, prompt };
    }

    const withBase64 = data.find((item) => typeof item[base64Field] === 'string' && item[base64Field]);
    if (withBase64) {
        return { kind, url: await saveBase64(kind, withBase64[base64Field] as string), prompt };
    }

    throw new Error(`Media API response had no ${urlField}: ${JSON.stringify(data).slice(0, 300)}`);
}

/** Generate an image through the configured media provider (Runware-compatible). */
export async function generateImage(
    prompt: string,
    options: { width?: number; height?: number; model?: string } = {}
): Promise<GeneratedMedia> {
    const settings = getMediaSettings();
    if (!settings) {
        throw new Error('Media generation is disabled. Set "telecode.media.enabled": true in VS Code settings.');
    }

    const model = options.model?.trim() || settings.imageModel;
    if (!model) {
        throw new Error('No image model configured. Set "telecode.media.imageModel".');
    }

    const task = {
        taskType: 'imageInference',
        taskUUID: randomUUID(),
        positivePrompt: prompt,
        model,
        width: Math.min(Math.max(options.width ?? 1024, 128), 2048),
        height: Math.min(Math.max(options.height ?? 1024, 128), 2048),
        numberResults: 1,
        outputFormat: 'JPEG'
    };

    return extractMedia('image', await runRunwareTask(settings, task), prompt);
}

/** Generate a short video through the configured media provider (Runware-compatible). */
export async function generateVideo(
    prompt: string,
    options: { width?: number; height?: number; durationSeconds?: number; model?: string } = {}
): Promise<GeneratedMedia> {
    const settings = getMediaSettings();
    if (!settings) {
        throw new Error('Media generation is disabled. Set "telecode.media.enabled": true in VS Code settings.');
    }

    const model = options.model?.trim() || settings.videoModel;
    if (!model) {
        throw new Error('No video model configured. Set "telecode.media.videoModel".');
    }

    const task = {
        taskType: 'videoInference',
        taskUUID: randomUUID(),
        positivePrompt: prompt,
        model,
        width: Math.min(Math.max(options.width ?? 1280, 128), 2048),
        height: Math.min(Math.max(options.height ?? 720, 128), 2048),
        duration: Math.min(Math.max(options.durationSeconds ?? 5, 1), 30)
    };

    return extractMedia('video', await runRunwareTask(settings, task), prompt);
}

/** Chat id of the conversation currently being answered, if any. */
export function getActiveChatId(): number | null {
    return activeChat();
}
