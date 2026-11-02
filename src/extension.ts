import * as vscode from 'vscode';
import TelegramBot, { type Message } from 'node-telegram-bot-api';
import { invokeTelecodeTool, registerTelecodeTools, telecodeTools } from './tools';
import { ConversationMemory, type StoredMessage } from './memory';
import {
    generateImage,
    generateVideo,
    getMediaSettings,
    initMedia,
    promptForMediaApiKey,
    setActiveChatProvider,
    takeMedia,
    type GeneratedMedia
} from './media';

let bot: TelegramBot | null = null;
let activeToken: string | null = null; // Token the running bot was started with
let outputChannel: vscode.OutputChannel;
let memory: ConversationMemory;
let activeTelegramChat: number | null = null; // Track active Telegram conversation
let extensionContext: vscode.ExtensionContext;

// Extension API that can be called by other extensions or commands
export interface TelegramAPI {
    sendToActiveTelegramChat(message: string): Promise<boolean>;
    isInTelegramContext(): boolean;
}

export function activate(context: vscode.ExtensionContext): TelegramAPI {
    console.log('TeleCode is now active');

    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel('TeleCode');
    context.subscriptions.push(outputChannel);

    memory = new ConversationMemory(context);

    // Tools the model can call while answering Telegram messages.
    registerTelecodeTools(context);

    // Restore active chat from previous session
    activeTelegramChat = context.globalState.get<number>('activeTelegramChat') || null;
    if (activeTelegramChat) {
        outputChannel.appendLine(`Restored active chat: ${activeTelegramChat}`);
    }

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('telecode.configure', configureBotToken)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('telecode.startBot', startBot)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('telecode.stopBot', stopBot)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('telecode.sendMessage', sendMessage)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('telecode.clearConversation', clearConversation)
    );

    // Register command for sending to active Telegram chat (for AI/other extensions to use)
    context.subscriptions.push(
        vscode.commands.registerCommand('telecode.sendToActiveChat', async (message: string) => {
            if (!bot || !activeTelegramChat) {
                vscode.window.showErrorMessage('No active Telegram conversation');
                return false;
            }
            try {
                await bot.sendMessage(activeTelegramChat, message);
                outputChannel.appendLine(`[Command] Sent to Telegram: ${message}`);
                return true;
            } catch (error) {
                outputChannel.appendLine(`[Command] Failed: ${error}`);
                return false;
            }
        })
    );

    // Test command with UI
    context.subscriptions.push(
        vscode.commands.registerCommand('telecode.testSend', async () => {
            if (!bot || !activeTelegramChat) {
                vscode.window.showErrorMessage('No active Telegram conversation. Send a message from Telegram first!');
                return;
            }

            const message = await vscode.window.showInputBox({
                prompt: 'Enter test message to send to Telegram',
                placeHolder: '🤖 Test message from Claude!',
                value: '🎉 Bu mesajı Claude kendisi gönderdi!'
            });

            if (message) {
                await vscode.commands.executeCommand('telecode.sendToActiveChat', message);
                vscode.window.showInformationMessage('Message sent to Telegram!');
            }
        })
    );

    // Choose which language model answers Telegram messages
    context.subscriptions.push(
        vscode.commands.registerCommand('telecode.selectModel', pickChatModel)
    );

    // Store the media provider key (Runware, ...) in Secret Storage
    context.subscriptions.push(
        vscode.commands.registerCommand('telecode.configureMediaKey', promptForMediaApiKey)
    );

    // Let media tools deliver generated images/videos to the active chat
    initMedia(context);
    setActiveChatProvider(() => activeTelegramChat);

    // Auto-start if configured
    const config = vscode.workspace.getConfiguration('telecode');
    if (config.get<boolean>('autoStart')) {
        startBot();
    }

    // Return API for other extensions to use
    const api: TelegramAPI = {
        sendToActiveTelegramChat: async (message: string) => {
            if (!bot || !activeTelegramChat) {
                return false;
            }
            try {
                await bot.sendMessage(activeTelegramChat, message);
                outputChannel.appendLine(`[API] Sent to Telegram chat ${activeTelegramChat}: ${message}`);
                return true;
            } catch (error) {
                outputChannel.appendLine(`[API] Failed to send: ${error}`);
                return false;
            }
        },
        isInTelegramContext: () => {
            return activeTelegramChat !== null;
        }
    };

    return api;
}

async function configureBotToken() {
    const input = await vscode.window.showInputBox({
        prompt: 'Enter your Telegram Bot Token',
        password: true,
        placeHolder: 'Get token from @BotFather'
    });

    const token = normalizeToken(input);
    if (token) {
        const config = vscode.workspace.getConfiguration('telecode');
        await config.update('botToken', token, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Bot token configured successfully!');
    }
}

/** Strip whitespace and accidental pasted quotes from the configured token. */
function normalizeToken(raw: string | undefined): string | undefined {
    const token = raw?.trim().replace(/^["']+|["']+$/g, '').trim();
    return token ? token : undefined;
}

/** Report which settings scope supplied the token (workspace overrides user). */
function describeTokenSource(config: vscode.WorkspaceConfiguration): string {
    const inspected = config.inspect<string>('botToken');
    if (inspected?.workspaceFolderValue !== undefined) {
        return 'workspace folder settings';
    }
    if (inspected?.workspaceValue !== undefined) {
        return 'workspace settings (.vscode/settings.json)';
    }
    if (inspected?.globalValue !== undefined) {
        return 'user settings';
    }
    return 'settings';
}

async function startBot() {
    const config = vscode.workspace.getConfiguration('telecode');
    const token = normalizeToken(config.get<string>('botToken'));

    if (!token) {
        const result = await vscode.window.showErrorMessage(
            'Bot token not configured!',
            'Configure Now'
        );
        if (result === 'Configure Now') {
            await configureBotToken();
            return;
        }
        return;
    }

    // A placeholder or truncated token would otherwise surface as a bare 404 from Telegram.
    if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
        const source = describeTokenSource(config);
        outputChannel.appendLine(`Invalid bot token format from ${source}.`);
        vscode.window.showErrorMessage(
            `Invalid bot token in ${source}. Expected something like 123456789:AAG... - remove any override there or run "TeleCode: Configure Bot Token".`
        );
        return;
    }

    if (bot) {
        if (activeToken === token) {
            vscode.window.showWarningMessage('Bot is already running!');
            return;
        }
        // Token changed since the bot started - restart with the new one.
        outputChannel.appendLine('Bot token changed - restarting bot.');
        await stopBotInstance();
    }

    const instance = new TelegramBot(token, { polling: false });

    // Verify the token before polling so failures are reported instead of logged later.
    try {
        const me = await instance.getMe();
        outputChannel.appendLine(`Authenticated as @${me.username} (bot id ${me.id})`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Token validation failed: ${message}`);
        if (/\b(401|404)\b/.test(message)) {
            vscode.window.showErrorMessage(
                `Telegram rejected the bot token (${message}). Check for extra characters or regenerate it with @BotFather, then run "TeleCode: Configure Bot Token".`
            );
        } else {
            vscode.window.showErrorMessage(`Could not reach Telegram: ${message}`);
        }
        return;
    }

    try {
        bot = instance;
        activeToken = token;

        bot.on('message', handleIncomingMessage);
        bot.on('polling_error', (error: Error) => {
            outputChannel.appendLine(`Polling error: ${error.message}`);

            if (/\b(401|404)\b/.test(error.message)) {
                outputChannel.appendLine('Token rejected - stopping polling. Re-run "TeleCode: Configure Bot Token".');
                bot = null;
                activeToken = null;
                instance.stopPolling().catch(() => undefined);
                vscode.window.showErrorMessage('Telegram bot stopped: bot token rejected (401/404).');
            }
        });

        await instance.startPolling();

        outputChannel.appendLine('Telegram bot started successfully!');
        vscode.window.showInformationMessage('Telegram bot is now running!');
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to start bot: ${error}`);
        bot = null;
        activeToken = null;
    }
}

async function stopBotInstance(): Promise<void> {
    const instance = bot;
    bot = null;
    activeToken = null;
    if (instance) {
        await instance.stopPolling().catch(() => undefined);
    }
}

async function stopBot() {
    if (!bot) {
        vscode.window.showWarningMessage('Bot is not running!');
        return;
    }

    await stopBotInstance();
    outputChannel.appendLine('Telegram bot stopped.');
    vscode.window.showInformationMessage('Telegram bot stopped.');
}

interface IncomingImage {
    mimeType: string;
    data: Uint8Array;
}

/** Telegram rejects bot downloads above 20 MB; keep a safety margin. */
const MAX_INCOMING_IMAGE_BYTES = 8 * 1024 * 1024;

/** Photos arrive as several sizes; documents only count when they are images. */
function incomingImageRefs(msg: Message): Array<{ fileId: string; mimeType: string }> {
    const refs: Array<{ fileId: string; mimeType: string }> = [];

    const photos = msg.photo;
    if (photos && photos.length > 0) {
        const largest = photos[photos.length - 1];
        refs.push({ fileId: largest.file_id, mimeType: 'image/jpeg' });
    }

    const document = msg.document;
    const documentMime = document?.mime_type || '';
    if (document && documentMime.startsWith('image/')) {
        refs.push({ fileId: document.file_id, mimeType: documentMime });
    }

    return refs;
}

async function downloadIncomingImages(msg: Message): Promise<IncomingImage[]> {
    if (!bot) {
        return [];
    }

    const refs = incomingImageRefs(msg).slice(0, 4);
    const images: IncomingImage[] = [];

    for (const ref of refs) {
        try {
            const link = await bot.getFileLink(ref.fileId);
            const response = await fetch(link);

            if (!response.ok) {
                throw new Error(`download failed (HTTP ${response.status})`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length === 0) {
                throw new Error('file was empty');
            }
            if (buffer.length > MAX_INCOMING_IMAGE_BYTES) {
                throw new Error(`file is too large (${Math.round(buffer.length / 1024 / 1024)} MB, limit ${MAX_INCOMING_IMAGE_BYTES / 1024 / 1024} MB)`);
            }

            outputChannel.appendLine(`Downloaded image ${ref.mimeType} (${Math.round(buffer.length / 1024)} KB)`);
            images.push({ mimeType: ref.mimeType, data: new Uint8Array(buffer) });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`Could not download image ${ref.fileId}: ${reason}`);
            void bot.sendMessage(msg.chat.id, `⚠️ I could not download that image: ${reason}`).catch(() => undefined);
        }
    }

    return images;
}

async function handleIncomingMessage(msg: Message) {
    if (!bot) {
        return;
    }

    const chatId = msg.chat.id;
    const text = msg.text || msg.caption || '';
    const imageCount = incomingImageRefs(msg).length;
    const username = msg.from?.username || msg.from?.first_name || 'Unknown';

    // Check if chat ID is allowed
    const config = vscode.workspace.getConfiguration('telecode');
    const allowedChatIds = config.get<number[]>('allowedChatIds') || [];

    const attachmentNote = imageCount > 0 ? ` [+${imageCount} image${imageCount > 1 ? 's' : ''}]` : '';
    outputChannel.appendLine(`Message from ${username} (${chatId}): ${text}${attachmentNote}`);

    // Handle /start command to show chat ID
    if (text.trim().toLowerCase() === '/start') {
        await bot.sendMessage(
            chatId,
            `Welcome to TeleCode!\n\nYour Chat ID: ${chatId}\n\nAdd this ID to your VS Code settings under 'telecode.allowedChatIds' to enable communication.\n\nSend /help to see everything I can do.`
        );
        return;
    }

    // Check authorization
    if (allowedChatIds.length > 0 && !allowedChatIds.includes(chatId)) {
        await bot.sendMessage(
            chatId,
            '⛔ Unauthorized. Your chat ID must be added to the allowed list in VS Code settings.'
        );
        return;
    }

    // Handle special commands
    const command = text.trim().toLowerCase();

    if (command === '/help' || command === '/commands') {
        await bot.sendMessage(chatId, HELP_TEXT);
        return;
    }

    if (command === '/clear') {
        const stats = memory.stats(chatId);
        if (stats.messages === 0 && stats.summaryChars === 0) {
            await bot.sendMessage(chatId, 'No conversation history to clear.');
        } else {
            await memory.clear(chatId);
            await bot.sendMessage(chatId, '✅ Conversation history and summary cleared!');
            outputChannel.appendLine(`Cleared memory for chat ${chatId}`);
        }
        return;
    }

    if (command === '/compact') {
        await handleCompactCommand(chatId);
        return;
    }

    if (command === '/status') {
        await handleStatusCommand(chatId);
        return;
    }

    if (command === '/image' || command === '/video') {
        await handleMediaCommand(chatId, text);
        return;
    }

    if (command === '/model' || command.startsWith('/model ')) {
        await handleModelCommand(chatId, text);
        return;
    }

    // Check if AI integration is enabled
    const enableAI = config.get<boolean>('enableAIIntegration');

    if (enableAI) {
        // Set active chat context and persist it
        activeTelegramChat = chatId;
        await extensionContext.globalState.update('activeTelegramChat', chatId);

        // Send "typing" action
        await bot.sendChatAction(chatId, 'typing');

        // Download photos/documents so the model can actually see them.
        const images = await downloadIncomingImages(msg);

        // Get response from Claude
        const claudeResponse = await askClaude(chatId, text, images);

        if (claudeResponse) {
            // Split long messages (Telegram has 4096 char limit)
            const maxLength = 4000;
            if (claudeResponse.length <= maxLength) {
                await bot.sendMessage(chatId, claudeResponse);
            } else {
                // Split into chunks
                const chunks = [];
                for (let i = 0; i < claudeResponse.length; i += maxLength) {
                    chunks.push(claudeResponse.substring(i, i + maxLength));
                }
                for (const chunk of chunks) {
                    await bot.sendMessage(chatId, chunk);
                }
            }
            outputChannel.appendLine(`telecode responded to ${username}`);
        } else {
            await bot.sendMessage(chatId, '❌ Failed to get response from Claude. Make sure Claude is available in VS Code.');
        }

        // Send any images/videos produced by the telecode_generate_* tools.
        await deliverGeneratedMedia(chatId);
    } else {
        // Show notification in VS Code for manual reply
        const preview = text || (imageCount > 0 ? '[image]' : '');
        const action = await vscode.window.showInformationMessage(
            `📱 ${username}: ${preview.substring(0, 50)}${preview.length > 50 ? '...' : ''}`,
            'Reply',
            'View in Output'
        );

        if (action === 'Reply') {
            const reply = await vscode.window.showInputBox({
                prompt: `Reply to ${username}`,
                placeHolder: 'Type your message...'
            });

            if (reply) {
                await bot.sendMessage(chatId, reply);
                outputChannel.appendLine(`Sent to ${username}: ${reply}`);
            }
        } else if (action === 'View in Output') {
            outputChannel.show();
        }
    }
}

async function sendMessage() {
    if (!bot) {
        vscode.window.showErrorMessage('Bot is not running! Start it first.');
        return;
    }

    const config = vscode.workspace.getConfiguration('telecode');
    const allowedChatIds = config.get<number[]>('allowedChatIds') || [];

    if (allowedChatIds.length === 0) {
        vscode.window.showErrorMessage('No chat IDs configured!');
        return;
    }

    const message = await vscode.window.showInputBox({
        prompt: 'Enter message to send',
        placeHolder: 'Type your message...'
    });

    if (message) {
        for (const chatId of allowedChatIds) {
            try {
                await bot.sendMessage(chatId, message);
                outputChannel.appendLine(`Sent to chat ${chatId}: ${message}`);
            } catch (error) {
                outputChannel.appendLine(`Failed to send to ${chatId}: ${error}`);
            }
        }
        vscode.window.showInformationMessage('Message sent!');
    }
}

// No longer needed - using VS Code's built-in Language Model API

function clearConversation() {
    void memory.clearAll().then(() => {
        vscode.window.showInformationMessage('Conversation history cleared!');
        outputChannel.appendLine('Conversation history and summaries cleared for all chats');
    });
}

const HELP_TEXT = [
    '🤖 TeleCode commands',
    '',
    '/help - show this list',
    '/status - show model, media and memory info',
    '/image <prompt> - generate an image and send it here',
    '/video <prompt> - generate a short video and send it here',
    '/model - list the language models VS Code offers',
    '/model <number> - switch to that model',
    '/compact - fold older messages into a summary now',
    '/clear - forget the conversation and its summary',
    '/start - show your chat ID',
    '',
    'Anything else goes to the selected model, which can read, search and edit this workspace and run commands.',
    'Send a photo (or an image file) with an optional caption and I will look at it - as long as the selected model supports images.',
    'Memory is kept per chat and survives VS Code restarts; it compacts automatically when it grows too large.'
].join('\n');

function toChatMessage(message: StoredMessage): vscode.LanguageModelChatMessage {
    return message.role === 'user'
        ? vscode.LanguageModelChatMessage.User(message.text)
        : vscode.LanguageModelChatMessage.Assistant(message.text);
}

/** Persist a finished exchange and compact in the background if memory grows too large. */
async function remember(chatId: number, userMessage: string, assistantMessage: string): Promise<void> {
    await memory.append(
        chatId,
        { role: 'user', text: userMessage },
        { role: 'assistant', text: assistantMessage }
    );

    void compactMemory(chatId, 'auto').catch((error) =>
        outputChannel.appendLine(`Auto-compaction failed: ${error}`)
    );
}

/** Summarise text with the selected model. Used only for compaction, never with tools. */
async function summariseWithModel(prompt: string): Promise<string | null> {
    const available = await vscode.lm.selectChatModels();
    if (available.length === 0) {
        return null;
    }

    const model = await pickPreferredModel(available);
    if (!model) {
        return null;
    }

    const tokenSource = new vscode.CancellationTokenSource();
    try {
        const response = await model.sendRequest(
            [vscode.LanguageModelChatMessage.User(prompt)],
            { justification: 'Compacting TeleCode conversation memory.' },
            tokenSource.token
        );

        let text = '';
        for await (const chunk of response.text) {
            text += chunk;
        }
        return text.trim() || null;
    } catch (error) {
        outputChannel.appendLine(`Compaction model call failed: ${error}`);
        return null;
    } finally {
        tokenSource.dispose();
    }
}

const COMPACTION_CHUNK_CHARS = 48000;
const SUMMARY_MAX_CHARS = 8000;

function buildSummaryPrompt(chunk: string, previous: string): string {
    return [
        previous ? `Existing summary of this conversation:\n${previous}\n` : '',
        'Conversation to fold into that summary:',
        chunk,
        '',
        'Write an updated summary for a coding assistant that will continue this conversation later.',
        'Keep goals, decisions, file paths, commands that were run, errors and open questions. Drop pleasantries.',
        'Respond with the summary text only (max 400 words).'
    ]
        .filter(Boolean)
        .join('\n');
}

/** Fold a long transcript into the summary chunk by chunk so nothing is silently dropped. */
async function summariseTranscript(transcript: string, previous: string): Promise<string | null> {
    let summary = previous;
    let produced = false;

    for (let offset = 0; offset < transcript.length; offset += COMPACTION_CHUNK_CHARS) {
        const chunk = transcript.slice(offset, offset + COMPACTION_CHUNK_CHARS);
        const result = await summariseWithModel(buildSummaryPrompt(chunk, summary));

        if (!result) {
            return produced ? summary : null;
        }

        summary = result.slice(0, SUMMARY_MAX_CHARS);
        produced = true;
    }

    return produced ? summary : null;
}

interface CompactionResult {
    before: { messages: number; chars: number; summaryChars: number };
    after: { messages: number; chars: number; summaryChars: number };
    summarised: boolean;
}

/**
 * Fold older messages into the running summary. Automatic runs are no-ops while the
 * memory is within limits; a manual `/compact` always runs.
 */
async function compactMemory(chatId: number, reason: 'auto' | 'manual'): Promise<CompactionResult | null> {
    const before = memory.stats(chatId);
    if (before.messages === 0) {
        return null;
    }
    if (reason === 'auto' && !memory.needsCompaction(chatId)) {
        return null;
    }

    const messages = memory.getMessages(chatId);
    const keepCount = Math.min(ConversationMemory.KEEP_RECENT, Math.max(0, messages.length - 2));
    const older = messages.slice(0, messages.length - keepCount);
    const kept = messages.slice(messages.length - keepCount);

    if (older.length === 0) {
        return { before, after: before, summarised: false };
    }

    const previous = memory.getSummary(chatId);
    const transcript = older
        .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
        .join('\n\n');

    const summary = (await summariseTranscript(transcript, previous)) ?? previous;
    const summarised = summary !== previous && summary.length > 0;

    await memory.setCompacted(chatId, summary, kept);

    const after = memory.stats(chatId);
    outputChannel.appendLine(
        `Compacted chat ${chatId} (${reason}): ${before.messages} msgs / ${before.chars} chars -> ${after.messages} msgs + ${after.summaryChars} char summary`
    );
    return { before, after, summarised };
}

/** Telegram `/status` command: backend, model and memory usage. */
async function handleStatusCommand(chatId: number): Promise<void> {
    if (!bot) {
        return;
    }

    const stats = memory.stats(chatId);
    const media = getMediaSettings();
    const lines = ['📊 TeleCode status', ''];

    lines.push(`Chat model: ${getConfiguredModelPreference() || '(first available VS Code model)'}`);

    if (media) {
        lines.push(`Media: enabled (${media.imageModel || 'no image model'} / ${media.videoModel || 'no video model'})`);
        lines.push(`Media endpoint: ${media.baseUrl}`);
    } else {
        lines.push('Media: disabled (set telecode.media.enabled to generate images/videos)');
    }

    lines.push(`Memory: ${stats.messages} messages, ${stats.chars} chars, ${stats.summaryChars} char summary`);
    lines.push(`Bot: ${bot ? 'running' : 'stopped'}`);

    await bot.sendMessage(chatId, lines.join('\n'));
}

/** Telegram `/compact` command. */
async function handleCompactCommand(chatId: number): Promise<void> {
    if (!bot) {
        return;
    }

    const stats = memory.stats(chatId);
    if (stats.messages === 0 && stats.summaryChars === 0) {
        await bot.sendMessage(chatId, 'Nothing to compact yet.');
        return;
    }

    await bot.sendChatAction(chatId, 'typing').catch(() => undefined);
    const result = await compactMemory(chatId, 'manual');

    if (!result) {
        await bot.sendMessage(chatId, 'Nothing to compact yet.');
        return;
    }

    if (result.before.messages === result.after.messages && !result.summarised) {
        await bot.sendMessage(
            chatId,
            `Memory is already compact: ${stats.messages} messages, ${stats.chars} chars, ${stats.summaryChars} char summary.`
        );
        return;
    }

    await bot.sendMessage(
        chatId,
        `🗜 Compacted ${result.before.messages} messages (${result.before.chars} chars) → ` +
            `${result.after.messages} messages (${result.after.chars} chars) + ${result.after.summaryChars} char summary.` +
            (result.summarised ? '' : '\n(Summary model was unavailable, so older turns were dropped without a summary.)')
    );
}

/** Loose comparison so "DeepSeek V4 Flash" matches the id "deepseek-v4-flash". */
function normalizeModelName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve the model configured in `telecode.modelId` against the models VS Code offers.
 * Accepts a model id, a `vendor/family` pair, or a bare family/vendor name.
 */
function matchPreferredModel(
    available: vscode.LanguageModelChat[],
    preference: string
): vscode.LanguageModelChat | undefined {
    const wanted = normalizeModelName(preference);
    const slash = preference.indexOf('/');

    return (
        available.find((m) => normalizeModelName(m.id) === wanted) ??
        available.find((m) => normalizeModelName(`${m.vendor}/${m.family}`) === wanted) ??
        (slash > 0
            ? available.find(
                  (m) =>
                      normalizeModelName(m.vendor) === normalizeModelName(preference.slice(0, slash)) &&
                      normalizeModelName(m.family) === normalizeModelName(preference.slice(slash + 1))
              )
            : undefined) ??
        available.find((m) => normalizeModelName(m.family) === wanted) ??
        available.find((m) => normalizeModelName(m.vendor) === wanted) ??
        available.find((m) => normalizeModelName(m.name ?? '') === wanted)
    );
}

/** Model choice is kept in extension state too, so a settings-schema miss can never block switching. */
const MODEL_STATE_KEY = 'activeModelId';

function getConfiguredModelPreference(): string {
    const stored = extensionContext.globalState.get<string>(MODEL_STATE_KEY);
    if (stored) {
        return stored.trim();
    }
    return (vscode.workspace.getConfiguration('telecode').get<string>('modelId') || '').trim();
}

async function saveModelPreference(modelId: string): Promise<void> {
    await extensionContext.globalState.update(MODEL_STATE_KEY, modelId);
    try {
        await vscode.workspace.getConfiguration('telecode').update(
            'modelId',
            modelId,
            vscode.ConfigurationTarget.Global
        );
    } catch (error) {
        // Older extension builds may not have the setting registered in the running window yet.
        outputChannel.appendLine(
            `Could not write telecode.modelId to settings (${error instanceof Error ? error.message : error}) - kept in extension state.`
        );
    }
}

async function pickPreferredModel(
    available: vscode.LanguageModelChat[]
): Promise<vscode.LanguageModelChat | undefined> {
    const preference = getConfiguredModelPreference();

    if (!preference) {
        return available[0];
    }

    const match = matchPreferredModel(available, preference);
    if (match) {
        return match;
    }

    outputChannel.appendLine(
        `Preferred model "${preference}" is not available - falling back to ${available[0].id}.`
    );
    return available[0];
}

/** Command: pick the model used for Telegram replies from a Quick Pick. */
async function pickChatModel(): Promise<void> {
    const models = await vscode.lm.selectChatModels();

    if (models.length === 0) {
        vscode.window.showErrorMessage('No language models are available in VS Code.');
        return;
    }

    const current = getConfiguredModelPreference();

    const items = models.map((m) => {
        const value = m.id || `${m.vendor}/${m.family}`;
        const isCurrent = current !== '' && matchPreferredModel([m], current) !== undefined;
        return {
            label: `${isCurrent ? '$(check) ' : ''}${m.name || m.id}`,
            description: `${m.vendor} · ${m.family}`,
            detail: m.id,
            modelId: value
        };
    });

    const chosen = await vscode.window.showQuickPick(items, {
        title: 'TeleCode: Select AI Model',
        placeHolder: 'Model used for Telegram replies',
        matchOnDescription: true,
        matchOnDetail: true
    });

    if (!chosen) {
        return;
    }

    await saveModelPreference(chosen.modelId);
    outputChannel.appendLine(`Model switched to ${chosen.modelId}`);
    vscode.window.showInformationMessage(`TeleCode will use ${chosen.label.replace('$(check) ', '')} (${chosen.description}).`);
}

/** Telegram `/model` command: list models, or select one by number. */
async function handleModelCommand(chatId: number, text: string): Promise<void> {
    if (!bot) {
        return;
    }

    const models = await vscode.lm.selectChatModels();
    if (models.length === 0) {
        await bot.sendMessage(chatId, 'No language models are available in VS Code.');
        return;
    }

    const current = getConfiguredModelPreference();
    const argument = text.slice('/model'.length).trim();

    if (!argument) {
        const active = current ? matchPreferredModel(models, current) : models[0];
        const lines = models.map((m, index) => {
            const isActive = active !== undefined && m.id === active.id;
            return `${index + 1}. ${isActive ? '✅ ' : ''}${m.name || m.id}\n     ${m.vendor}/${m.family} · ${m.id}`;
        });

        await bot.sendMessage(
            chatId,
            `🧠 Available models:\n\n${lines.join('\n')}\n\nSend /model <number> to switch.` +
                (current ? `\nPinned: ${current}` : '\nNo model pinned - using the first one.')
        );
        return;
    }

    const index = Number.parseInt(argument, 10);
    if (!Number.isInteger(index) || index < 1 || index > models.length) {
        await bot.sendMessage(chatId, `Send /model to list models, then /model <number> (1-${models.length}).`);
        return;
    }

    const selected = models[index - 1];
    await saveModelPreference(selected.id);
    outputChannel.appendLine(`Model switched to ${selected.id}`);
    await bot.sendMessage(chatId, `✅ Now using ${selected.name || selected.id} (${selected.vendor}/${selected.family}).`);
}

/** Tool names worth offering to a coding agent, in rough priority order. */
const PREFERRED_TOOL_PATTERN =
    /file|folder|dir|search|text|grep|edit|replace|write|create|apply|patch|terminal|task|command|git|error|diagnostic|test|workspace/i;

/**
 * Tools that only work inside a Copilot chat request: they need the chat panel's
 * stream / input context / tool invocation token, so invoking them over the Language
 * Model API throws "Invalid stream", "_inputContext is not set" or
 * "Invocation context must be provided". TeleCode ships and executes its own tool
 * set instead (see tools.ts), and never offers these to the model.
 */
const CHAT_ONLY_TOOL_PATTERN =
    /^(copilot_|run_in_terminal$|terminal_last_command$|get_terminal_output$|run_task$|read_file$|grep_search$|file_search$|list_dir$|replace_string_in_file$|create_file$|apply_?patch$|create_?file$|get_errors$|.*subagent.*$|switch_agent$|skill$|tool_search$|.*session_store.*$|resolve_memory_file_uri$|.*_view$)/i;

/** Tools that failed at runtime because they cannot run outside the chat panel. */
const ungrantedTools = new Set<string>();

const MAX_TOOL_COUNT = 48;
const MAX_TOOL_ROUNDS = 10;

/**
 * Tools offered to the model: TeleCode's own tools first (always executable),
 * then other extensions' tools that are not chat-panel-only.
 */
function collectChatTools(): vscode.LanguageModelChatTool[] {
    const own: vscode.LanguageModelChatTool[] = telecodeTools.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema
    }));

    const ownNames = new Set(own.map((tool) => tool.name));

    const foreign = (vscode.lm.tools ?? [])
        .filter(
            (tool) =>
                !ownNames.has(tool.name) &&
                !ungrantedTools.has(tool.name) &&
                !CHAT_ONLY_TOOL_PATTERN.test(tool.name)
        )
        .slice()
        .sort(
            (a, b) =>
                Number(PREFERRED_TOOL_PATTERN.test(`${b.name} ${b.description ?? ''}`)) -
                Number(PREFERRED_TOOL_PATTERN.test(`${a.name} ${a.description ?? ''}`))
        );

    const budget = Math.max(0, MAX_TOOL_COUNT - own.length);
    return [
        ...own,
        ...foreign.slice(0, budget).map((tool) => ({
            name: tool.name,
            description: tool.description || tool.name,
            inputSchema: tool.inputSchema as object | undefined
        }))
    ];
}

/** Tell the model it is running inside the workspace, so it uses tools instead of refusing. */
function buildWorkspaceContext(): string {
    const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const lines = [
        'You are TeleCode, an AI coding assistant reached over Telegram but running inside the user\'s VS Code window.',
        'You DO have access to the workspace and its repository through the provided tools: use them to inspect files, search, run commands and make edits.',
        'Never claim you cannot see the files or the repository without first calling the available tools. Prefer doing the work over telling the user to run commands themselves.',
        'Use telecode_run_command for shell work such as git add/commit/push, npm and dotnet. Use telecode_list_dir to browse, telecode_read_file to inspect, telecode_search to grep, and telecode_write_file to create or overwrite files.',
        'The copilot_* tools, run_in_terminal, read_file, create_file, apply_patch and the subagent tools require the chat panel and always fail here - do not call them.',
        'If a tool call fails, try one alternative tool. If that fails too, stop and report the exact error instead of retrying the same call.',
        'Keep replies short: they are delivered as Telegram messages.'
    ];

    lines.push(
        folders.length > 0
            ? `Workspace folders: ${folders.join(', ')}`
            : 'No folder is open in this VS Code window.'
    );

    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
        lines.push(`Active file: ${relative}`);
    }

    return lines.join('\n');
}

/**
 * Send any media generated while answering to the chat, falling back to a link.
 */
async function deliverGeneratedMedia(chatId: number): Promise<void> {
    if (!bot) {
        return;
    }

    for (const media of takeMedia(chatId)) {
        try {
            if (media.kind === 'image') {
                await bot.sendPhoto(chatId, media.url, { caption: media.prompt.slice(0, 900) });
            } else {
                await bot.sendVideo(chatId, media.url, { caption: media.prompt.slice(0, 900) });
            }
        } catch (error) {
            outputChannel.appendLine(`Failed to send generated ${media.kind}: ${error}`);
            await bot.sendMessage(chatId, `Generated ${media.kind}: ${media.url}`);
        }
    }
}

/** Telegram `/image <prompt>` and `/video <prompt>` commands. */
async function handleMediaCommand(chatId: number, text: string): Promise<void> {
    if (!bot) {
        return;
    }

    const [rawCommand, ...rest] = text.trim().split(/\s+/);
    const kind = rawCommand.toLowerCase() === '/video' ? 'video' : 'image';
    const prompt = rest.join(' ').trim();

    if (!prompt) {
        await bot.sendMessage(chatId, `Usage: /${kind} <prompt>`);
        return;
    }

    if (!getMediaSettings()) {
        await bot.sendMessage(
            chatId,
            'Media generation is disabled. Set "telecode.media.enabled": true and the model names in VS Code settings, then run "TeleCode: Configure Media API Key".'
        );
        return;
    }

    await bot.sendChatAction(chatId, kind === 'image' ? 'upload_photo' : 'upload_video').catch(() => undefined);

    try {
        const media: GeneratedMedia = kind === 'video' ? await generateVideo(prompt) : await generateImage(prompt);
        if (kind === 'video') {
            await bot.sendVideo(chatId, media.url, { caption: media.prompt.slice(0, 900) });
        } else {
            await bot.sendPhoto(chatId, media.url, { caption: media.prompt.slice(0, 900) });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Media generation failed: ${message}`);
        await bot.sendMessage(chatId, `⚠️ Could not generate ${kind}: ${message}`);
    }
}

async function askClaude(chatId: number, userMessage: string, images: IncomingImage[] = []): Promise<string | null> {
    let activeModelLabel = 'the selected model';

    try {
        const available = await vscode.lm.selectChatModels();

        if (available.length === 0) {
            outputChannel.appendLine('No language model available');
            return 'No language model available in VS Code. Make sure a Language Model provider is installed and signed in.';
        }

        const model = await pickPreferredModel(available);

        if (!model) {
            return 'No language model available in VS Code. Make sure a Language Model provider is installed and signed in.';
        }

        activeModelLabel = `${model.name || model.id} (${model.vendor}/${model.family})`;
        outputChannel.appendLine(`Using model: ${activeModelLabel}`);

        // Keep the transcript within limits before it is sent to the model.
        if (memory.needsCompaction(chatId)) {
            await compactMemory(chatId, 'auto');
        }

        const summary = memory.getSummary(chatId);
        const stored = memory.getMessages(chatId);

        const promptText = userMessage.trim() || (images.length > 0 ? 'Describe this image.' : userMessage);
        const memoryText =
            images.length > 0
                ? `${promptText || '(image)'}\n[${images.length} image${images.length > 1 ? 's' : ''} attached: ${images.map((image) => image.mimeType).join(', ')}]`
                : userMessage;

        const userMessageContent = images.length > 0
            ? vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelTextPart(promptText || '(image)'),
                ...images.map((image) => vscode.LanguageModelDataPart.image(image.data, image.mimeType))
            ])
            : vscode.LanguageModelChatMessage.User(userMessage);

        const tools = collectChatTools();
        outputChannel.appendLine(`Tools available: ${tools.length}${tools.length ? ` (${tools.slice(0, 8).map((t) => t.name).join(', ')}${tools.length > 8 ? ', ...' : ''})` : ''}`);

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(buildWorkspaceContext()),
            ...(summary
                ? [vscode.LanguageModelChatMessage.User(`Summary of the earlier conversation:\n${summary}`)]
                : []),
            ...stored.map(toChatMessage),
            userMessageContent
        ];

        const tokenSource = new vscode.CancellationTokenSource();
        let lastText = '';

        try {
            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                const response = await model.sendRequest(
                    messages,
                    {
                        tools: tools.length > 0 ? tools : undefined,
                        justification: 'Answering a Telegram message from the workspace owner.'
                    },
                    tokenSource.token
                );

                const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
                let text = '';

                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        text += part.value;
                        parts.push(part);
                    } else if (part instanceof vscode.LanguageModelToolCallPart) {
                        parts.push(part);
                    }
                }

                if (text) {
                    lastText = text;
                }

                const toolCalls = parts.filter(
                    (part): part is vscode.LanguageModelToolCallPart =>
                        part instanceof vscode.LanguageModelToolCallPart
                );

                if (toolCalls.length === 0) {
                    await remember(chatId, memoryText, text);
                    return text;
                }

                // Feed the tool calls back to the model, then execute them.
                messages.push(vscode.LanguageModelChatMessage.Assistant(parts));

                for (const call of toolCalls) {
                    const safeInput = JSON.stringify(call.input ?? {}).slice(0, 300);
                    outputChannel.appendLine(`Tool call: ${call.name} ${safeInput}`);

                    let resultPart: vscode.LanguageModelToolResultPart;
                    try {
                        // TeleCode's own tools run in-process; everything else goes through VS Code.
                        const native = call.name.startsWith('telecode_')
                            ? await invokeTelecodeTool(call.name, call.input)
                            : undefined;

                        const result =
                            native ??
                            (await vscode.lm.invokeTool(
                                call.name,
                                { input: call.input, toolInvocationToken: undefined },
                                tokenSource.token
                            ));

                        resultPart = new vscode.LanguageModelToolResultPart(call.callId, result.content);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        outputChannel.appendLine(`Tool ${call.name} failed: ${message}`);

                        const chatOnly = /_inputContext|Invalid stream|Missing patch text|Invocation context|is not set|not available|not supported/i.test(message);
                        if (chatOnly) {
                            ungrantedTools.add(call.name);
                            outputChannel.appendLine(`Disabling tool "${call.name}" for this session (chat-panel only).`);
                        }

                        const hint = chatOnly
                            ? `Tool "${call.name}" cannot run outside the chat panel and has been disabled. Use telecode_read_file / telecode_write_file / telecode_list_dir / telecode_search / telecode_run_command instead.`
                            : `Tool "${call.name}" failed: ${message}. Try a different tool, or stop and report this error to the user.`;

                        resultPart = new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(hint)
                        ]);
                    }

                    messages.push(vscode.LanguageModelChatMessage.User([resultPart]));
                }

                if (bot) {
                    await bot.sendChatAction(chatId, 'typing').catch(() => undefined);
                }
            }
        } finally {
            tokenSource.dispose();
        }

        // Tool budget exhausted: keep whatever the model said last.
        const fallback = lastText || 'Stopped after too many tool calls without a final answer.';
        await remember(chatId, memoryText, fallback);
        return fallback;
    } catch (error) {
        if (error instanceof vscode.LanguageModelError) {
            outputChannel.appendLine(`Language Model error: ${error.message} (${error.code})`);

            if (error.code === vscode.LanguageModelError.NotFound.name) {
                return 'The selected model is not available. Run "TeleCode: Select AI Model" or /model to pick another.';
            } else if (error.code === vscode.LanguageModelError.NoPermissions.name) {
                return 'No permission to use the selected model. Check your VS Code settings.';
            }
        }

        if (images.length > 0) {
            const reason = error instanceof Error ? error.message : String(error);
            const looksLikeModality =
                /image|vision|modalit|content|media|part|attachment|unsupported|not support/i.test(reason);

            outputChannel.appendLine(`Image request failed: ${reason}`);
            return looksLikeModality
                ? `⚠️ ${activeModelLabel} cannot read images, so the picture never reached the model.\n\nUse /model to switch to a vision-capable model, then resend the image.`
                : `⚠️ Could not process that image with ${activeModelLabel}: ${reason}`;
        }

        outputChannel.appendLine(`Chat error: ${error}`);
        return null;
    }
}

export function deactivate() {
    if (bot) {
        bot.stopPolling();
    }
}
