import * as vscode from 'vscode';
import TelegramBot from 'node-telegram-bot-api';

let bot: TelegramBot | null = null;
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
    const token = await vscode.window.showInputBox({
        prompt: 'Enter your Telegram Bot Token',
        password: true,
        placeHolder: 'Get token from @BotFather'
    });

    if (token) {
        const config = vscode.workspace.getConfiguration('telecode');
        await config.update('botToken', token, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Bot token configured successfully!');
    }
}

async function startBot() {
    if (bot) {
        vscode.window.showWarningMessage('Bot is already running!');
        return;
    }

    const config = vscode.workspace.getConfiguration('telecode');
    const token = config.get<string>('botToken');

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

    try {
        bot = new TelegramBot(token, { polling: true });

        bot.on('message', handleIncomingMessage);
        bot.on('polling_error', (error: Error) => {
            outputChannel.appendLine(`Polling error: ${error.message}`);
        });

        outputChannel.appendLine('Telegram bot started successfully!');
        vscode.window.showInformationMessage('Telegram bot is now running!');
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to start bot: ${error}`);
        bot = null;
    }
}

function stopBot() {
    if (!bot) {
        vscode.window.showWarningMessage('Bot is not running!');
        return;
    }

    bot.stopPolling();
    bot = null;
    outputChannel.appendLine('Telegram bot stopped.');
    vscode.window.showInformationMessage('Telegram bot stopped.');
}

async function handleIncomingMessage(msg: TelegramBot.Message) {
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
            outputChannel.appendLine(`Claude responded to ${username}`);
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

async function askClaude(chatId: number, userMessage: string): Promise<string | null> {
    try {
        // Get available language models - try without selector first to get any available model
        let models = await vscode.lm.selectChatModels();

        if (models.length === 0) {
            outputChannel.appendLine('No language model available');
            return 'No language model available in VS Code. Please ensure you have Claude Code extension installed and active.';
        }

        outputChannel.appendLine(`Found ${models.length} models. Using: ${models[0].name || models[0].id}`);

        // Log all available models for debugging
        for (const m of models) {
            outputChannel.appendLine(`  - Model: ${m.id}, vendor: ${m.vendor}, family: ${m.family}`);
        }

        const model = models[0];

        // Get or create conversation history for this chat
        if (!conversationHistory.has(chatId)) {
            conversationHistory.set(chatId, []);
        }

        const history = conversationHistory.get(chatId)!;

        // Add user message to history
        const userMsg = vscode.LanguageModelChatMessage.User(userMessage);
        history.push(userMsg);

        // Send request to Claude via VS Code Language Model API
        const response = await model.sendRequest(history, {}, new vscode.CancellationTokenSource().token);

        // Collect response text
        let assistantMessage = '';
        for await (const chunk of response.text) {
            assistantMessage += chunk;
        }

        // Add assistant response to history
        const assistantMsg = vscode.LanguageModelChatMessage.Assistant(assistantMessage);
        history.push(assistantMsg);

        // Keep only last 10 exchanges (20 messages)
        if (history.length > 20) {
            history.splice(0, history.length - 20);
        }

        return assistantMessage;
    } catch (error) {
        if (error instanceof vscode.LanguageModelError) {
            outputChannel.appendLine(`Language Model error: ${error.message} (${error.code})`);

            if (error.code === vscode.LanguageModelError.NotFound.name) {
                return 'Claude model not found. Please ensure Claude is available in your VS Code.';
            } else if (error.code === vscode.LanguageModelError.NoPermissions.name) {
                return 'No permission to access Claude. Please check your VS Code settings.';
            }
        }

        outputChannel.appendLine(`Claude error: ${error}`);
        return null;
    }
}

export function deactivate() {
    if (bot) {
        bot.stopPolling();
    }
}
