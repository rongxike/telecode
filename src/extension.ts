import * as vscode from 'vscode';
import TelegramBot, { type Message } from 'node-telegram-bot-api';

let bot: TelegramBot | null = null;
let activeToken: string | null = null; // Token the running bot was started with
let outputChannel: vscode.OutputChannel;
let conversationHistory = new Map<number, vscode.LanguageModelChatMessage[]>();
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

async function handleIncomingMessage(msg: Message) {
    if (!bot) return;

    const chatId = msg.chat.id;
    const text = msg.text || '';
    const username = msg.from?.username || msg.from?.first_name || 'Unknown';

    // Check if chat ID is allowed
    const config = vscode.workspace.getConfiguration('telecode');
    const allowedChatIds = config.get<number[]>('allowedChatIds') || [];

    outputChannel.appendLine(`Message from ${username} (${chatId}): ${text}`);

    // Handle /start command to show chat ID
    if (text === '/start') {
        await bot.sendMessage(
            chatId,
            `Welcome to VS Code Telegram Bridge!\n\nYour Chat ID: ${chatId}\n\nAdd this ID to your VS Code settings under 'telecode.allowedChatIds' to enable communication.`
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
    if (text === '/clear') {
        if (conversationHistory.has(chatId)) {
            conversationHistory.delete(chatId);
            await bot.sendMessage(chatId, '✅ Conversation history cleared!');
            outputChannel.appendLine(`Cleared conversation for chat ${chatId}`);
        } else {
            await bot.sendMessage(chatId, 'No conversation history to clear.');
        }
        return;
    }

    if (text === '/model' || text.startsWith('/model ')) {
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

        // Get response from Claude
        const claudeResponse = await askClaude(chatId, text);

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
    } else {
        // Show notification in VS Code for manual reply
        const action = await vscode.window.showInformationMessage(
            `📱 ${username}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`,
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
    conversationHistory.clear();
    vscode.window.showInformationMessage('Conversation history cleared!');
    outputChannel.appendLine('Conversation history cleared');
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

/** Concrete tool names to surface first when the provider publishes them. */
const PREFERRED_TOOL_NAMES = [
    'read_file',
    'grep_search',
    'file_search',
    'list_dir',
    'replace_string_in_file',
    'create_file',
    'run_in_terminal',
    'terminal_last_command',
    'get_terminal_output',
    'run_task',
    'get_errors'
];

/**
 * Tools that only work inside a Copilot chat request: they need the chat panel's
 * input context / tool invocation token, so invoking them over the Language Model
 * API throws "_inputContext is not set".
 */
const CHAT_ONLY_TOOL_PATTERN =
    /subagent|^switch_agent$|^skill$|^tool_search$|^session_store|^resolve_memory_file_uri$|_view$/i;

/** Tools that failed at runtime because they cannot run outside the chat panel. */
const ungrantedTools = new Set<string>();

const MAX_TOOL_COUNT = 48;
const MAX_TOOL_ROUNDS = 10;

/** Chat tools published by other extensions (Copilot, MCP servers, ...). */
function collectChatTools(): vscode.LanguageModelChatTool[] {
    const all = (vscode.lm.tools ?? []).filter(
        (tool) => !ungrantedTools.has(tool.name) && !CHAT_ONLY_TOOL_PATTERN.test(tool.name)
    );

    if (all.length === 0) {
        return [];
    }

    const ranked: vscode.LanguageModelToolInformation[] = [];
    const rest: vscode.LanguageModelToolInformation[] = [];

    for (const name of PREFERRED_TOOL_NAMES) {
        const match = all.find((tool) => tool.name === name);
        if (match) {
            ranked.push(match);
        }
    }

    for (const tool of all) {
        if (ranked.includes(tool)) {
            continue;
        }
        const haystack = `${tool.name} ${tool.description ?? ''}`;
        (PREFERRED_TOOL_PATTERN.test(haystack) ? ranked : rest).push(tool);
    }

    return [...ranked, ...rest].slice(0, MAX_TOOL_COUNT).map((tool) => ({
        name: tool.name,
        description: tool.description || tool.name,
        inputSchema: tool.inputSchema as object | undefined
    }));
}

/** Tell the model it is running inside the workspace, so it uses tools instead of refusing. */
function buildWorkspaceContext(): string {
    const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const lines = [
        'You are TeleCode, an AI coding assistant reached over Telegram but running inside the user\'s VS Code window.',
        'You DO have access to the workspace and its repository through the provided tools: use them to inspect files, search, run commands and make edits.',
        'Never claim you cannot see the files or the repository without first calling the available tools. Prefer doing the work over telling the user to run commands themselves.',
        'Use run_in_terminal for shell work such as git add/commit/push. Do not call subagent, skill or switch_agent tools - they are unavailable in this context.',
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

async function askClaude(chatId: number, userMessage: string): Promise<string | null> {
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

        outputChannel.appendLine(`Using model: ${model.name || model.id} (${model.vendor}/${model.family})`);

        if (!conversationHistory.has(chatId)) {
            conversationHistory.set(chatId, []);
        }

        const history = conversationHistory.get(chatId)!;
        const userMsg = vscode.LanguageModelChatMessage.User(userMessage);

        const tools = collectChatTools();
        outputChannel.appendLine(`Tools available: ${tools.length}${tools.length ? ` (${tools.slice(0, 8).map((t) => t.name).join(', ')}${tools.length > 8 ? ', ...' : ''})` : ''}`);

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(buildWorkspaceContext()),
            ...history,
            userMsg
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
                    history.push(userMsg, vscode.LanguageModelChatMessage.Assistant(text));
                    if (history.length > 20) {
                        history.splice(0, history.length - 20);
                    }
                    return text;
                }

                // Feed the tool calls back to the model, then execute them.
                messages.push(vscode.LanguageModelChatMessage.Assistant(parts));

                for (const call of toolCalls) {
                    const safeInput = JSON.stringify(call.input ?? {}).slice(0, 300);
                    outputChannel.appendLine(`Tool call: ${call.name} ${safeInput}`);

                    let resultPart: vscode.LanguageModelToolResultPart;
                    try {
                        const result = await vscode.lm.invokeTool(
                            call.name,
                            { input: call.input, toolInvocationToken: undefined },
                            tokenSource.token
                        );
                        resultPart = new vscode.LanguageModelToolResultPart(call.callId, result.content);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        outputChannel.appendLine(`Tool ${call.name} failed: ${message}`);

                        const chatOnly = /_inputContext|is not set|not available|not supported/i.test(message);
                        if (chatOnly) {
                            ungrantedTools.add(call.name);
                            outputChannel.appendLine(`Disabling tool "${call.name}" for this session (chat-panel only).`);
                        }

                        const hint = chatOnly
                            ? `Tool "${call.name}" cannot run outside the chat panel and has been disabled. Use run_in_terminal, read_file, grep_search or another available tool instead.`
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
        history.push(userMsg, vscode.LanguageModelChatMessage.Assistant(lastText));
        if (history.length > 20) {
            history.splice(0, history.length - 20);
        }

        return lastText || 'Stopped after too many tool calls without a final answer.';
    } catch (error) {
        if (error instanceof vscode.LanguageModelError) {
            outputChannel.appendLine(`Language Model error: ${error.message} (${error.code})`);

            if (error.code === vscode.LanguageModelError.NotFound.name) {
                return 'The selected model is not available. Run "TeleCode: Select AI Model" or /model to pick another.';
            } else if (error.code === vscode.LanguageModelError.NoPermissions.name) {
                return 'No permission to use the selected model. Check your VS Code settings.';
            }
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
