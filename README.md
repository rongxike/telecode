# TeleCode

Bridge your VS Code with Telegram - control your IDE from anywhere! Work with AI assistants, monitor tasks, and stay connected to your development environment through Telegram.

## Features

- **Telegram Bot Integration**: Connect your VS Code instance to a Telegram bot
- **AI Assistant Integration**: Works with any VS Code Language Model (Claude, GPT, Gemini, etc.)
- **Bidirectional Communication**: Send and receive messages between Telegram and VS Code
- **Extension API**: Other extensions can send notifications via Telegram
- **Conversation History**: Maintains context across messages (last 10 exchanges)
- **Secure**: Whitelist specific chat IDs for security
- **Persistent State**: Active chat survives VS Code restarts
- **Auto-start**: Optional automatic bot startup with VS Code

## Setup

### 1. Create Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the instructions
3. Copy the bot token you receive

### 2. Configure VS Code Extension

1. Open VS Code Command Palette (`Cmd+Shift+P` or `Ctrl+Shift+P`)
2. Run `TeleCode: Configure Bot Token`
3. Paste your bot token

### 3. Start the Bot

1. Run `TeleCode: Start Bot` command
2. Open your bot on Telegram
3. Send `/start` to get your chat ID
4. Add your chat ID to VS Code settings:
   - Open Settings (`Cmd+,` or `Ctrl+,`)
   - Search for `telecode.allowedChatIds`
   - Add your chat ID to the array (e.g., `[123456789]`)

## Usage

### Telegram Bot Commands

- **`/start`**: Get your chat ID and welcome message
- **`/clear`**: Clear conversation history

### From Telegram

Simply send any message to your bot! If AI integration is enabled, you'll get automatic responses from your configured Language Model.

### From VS Code

- **`TeleCode: Send Message`**: Send a message to all configured chat IDs
- **`TeleCode: Start Bot`**: Start the Telegram bot
- **`TeleCode: Stop Bot`**: Stop the Telegram bot
- **`TeleCode: Clear Conversation History`**: Clear all conversation histories
- **`TeleCode: Test Send`**: Test sending a message to active chat
- **`TeleCode: Send to Active Chat`**: Programmatically send message (for extensions)

## Configuration

All settings are available under `telecode` in VS Code settings:

- **`botToken`**: Your Telegram Bot API token
- **`allowedChatIds`**: Array of allowed chat IDs (for security)
- **`autoStart`**: Automatically start bot on VS Code startup
- **`enableAIIntegration`**: Enable/disable automatic AI responses via Language Model API

## Features in Detail

### Conversation Context

The extension maintains conversation history for each chat, allowing your AI assistant to understand context across multiple messages. History is limited to the last 10 exchanges (20 messages) to balance context and token usage.

### Extension API

Other VS Code extensions can integrate with TeleCode:

```typescript
// Get TeleCode API
const telecodeExt = vscode.extensions.getExtension('your-publisher.telecode');
const telecode = telecodeExt?.exports;

// Send message to active Telegram chat
if (telecode?.isInTelegramContext()) {
    await telecode.sendToActiveTelegramChat('Hello from my extension!');
}

// Or use command
await vscode.commands.executeCommand('telecode.sendToActiveChat', 'My message');
```

### Message Length Handling

Long AI responses are automatically split into multiple Telegram messages to respect Telegram's 4096 character limit.

### Security

- Only whitelisted chat IDs can interact with your bot
- API keys are stored securely in VS Code settings
- Unauthorized access attempts are logged and rejected

## Troubleshooting

### Bot not responding

1. Check if the bot is running: `TeleCode: Start Bot`
2. Verify your bot token is correct
3. Ensure your chat ID is in the allowed list
4. Check Output channel: View → Output → Select "TeleCode"

### AI not responding

1. Check that `enableAIIntegration` is enabled in settings
2. Ensure you have a Language Model available in VS Code (Claude Code, GitHub Copilot, etc.)
3. Check the Output channel for error messages

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch
```

## License

MIT
