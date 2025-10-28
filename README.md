# Telegram Claude Bridge

VS Code extension that allows you to communicate with Claude AI through Telegram. Never miss a conversation with Claude - chat from anywhere using Telegram!

## Features

- **Telegram Bot Integration**: Connect your VS Code instance to a Telegram bot
- **Claude AI Integration**: Automatic responses powered by Claude Sonnet 4.5
- **Conversation History**: Maintains context across messages (last 10 exchanges)
- **Secure**: Whitelist specific chat IDs for security
- **Bidirectional**: Send and receive messages from both VS Code and Telegram
- **Auto-start**: Optional automatic bot startup with VS Code

## Setup

### 1. Create Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the instructions
3. Copy the bot token you receive

### 2. Configure VS Code Extension

1. Open VS Code Command Palette (`Cmd+Shift+P` or `Ctrl+Shift+P`)
2. Run `Telegram: Configure Bot Token`
3. Paste your bot token

### 3. Configure Claude API (Optional but recommended)

1. Get your Anthropic API key from [console.anthropic.com](https://console.anthropic.com)
2. Run `Telegram: Configure Claude API Key`
3. Paste your API key

### 4. Start the Bot

1. Run `Telegram: Start Bot` command
2. Open your bot on Telegram
3. Send `/start` to get your chat ID
4. Add your chat ID to VS Code settings:
   - Open Settings (`Cmd+,` or `Ctrl+,`)
   - Search for `telegramClaude.allowedChatIds`
   - Add your chat ID to the array (e.g., `[123456789]`)

## Usage

### Basic Commands

- **`/start`**: Get your chat ID and welcome message
- **`/clear`**: Clear conversation history with Claude

### From Telegram

Simply send any message to your bot! If Claude integration is enabled, you'll get automatic AI-powered responses.

### From VS Code

- **`Telegram: Send Message`**: Send a message to all configured chat IDs
- **`Telegram: Start Bot`**: Start the Telegram bot
- **`Telegram: Stop Bot`**: Stop the Telegram bot
- **`Telegram: Clear Conversation History`**: Clear all conversation histories

## Configuration

All settings are available under `telegramClaude` in VS Code settings:

- **`botToken`**: Your Telegram Bot API token
- **`allowedChatIds`**: Array of allowed chat IDs (for security)
- **`autoStart`**: Automatically start bot on VS Code startup
- **`anthropicApiKey`**: Your Anthropic API key for Claude
- **`enableClaudeIntegration`**: Enable/disable automatic Claude responses

## Features in Detail

### Conversation Context

The extension maintains conversation history for each chat, allowing Claude to understand context across multiple messages. History is limited to the last 10 exchanges (20 messages) to balance context and token usage.

### Message Length Handling

Long Claude responses are automatically split into multiple Telegram messages to respect Telegram's 4096 character limit.

### Security

- Only whitelisted chat IDs can interact with your bot
- API keys are stored securely in VS Code settings
- Unauthorized access attempts are logged and rejected

## Troubleshooting

### Bot not responding

1. Check if the bot is running: `Telegram: Start Bot`
2. Verify your bot token is correct
3. Ensure your chat ID is in the allowed list
4. Check Output channel: View → Output → Select "Telegram Claude"

### Claude not responding

1. Verify your Anthropic API key is configured
2. Check that `enableClaudeIntegration` is enabled
3. Ensure you have API credits available
4. Check the Output channel for error messages

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
