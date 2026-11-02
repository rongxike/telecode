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

- **`/help`**: List every command (`/commands` also works)
- **`/start`**: Get your chat ID and welcome message
- **`/status`**: Show model, media backend and memory usage
- **`/image <prompt>`**: Generate an image and send it here
- **`/video <prompt>`**: Generate a short video and send it here
- **`/model`**: List available language models; `/model <number>` switches to one
- **`/compact`**: Fold older messages into a summary right now
- **`/clear`**: Clear the conversation history and its summary

### Media generation (Runware-compatible)

The bot can generate images and videos through a media API such as [Runware](https://runware.ai):

```json
{
	"telecode.media.enabled": true,
	"telecode.media.baseUrl": "https://api.runware.ai/v1",
	"telecode.media.imageModel": "runware:100@1",
	"telecode.media.videoModel": "<your video model id>"
}
```

Then run **TeleCode: Configure Media API Key** and paste the key. It is stored in VS Code's **Secret Storage** — never in `settings.json` and never in the repository.

From Telegram:

- `/image a watercolor fox reading a book` — generate and send an image
- `/video a timelapse of clouds over a city` — generate and send a short video

The model can also call `telecode_generate_image` and `telecode_generate_video` itself when you ask for a picture or clip in natural language; the generated file is delivered to the chat automatically.

### Sending images to the bot

Send a photo or an image file (JPEG/PNG/WebP/GIF) with an optional caption and TeleCode downloads it and attaches it to the request as an image part, so the model can actually look at it. A caption such as "what is wrong in this screenshot?" becomes the prompt; without a caption the bot asks the model to describe the image.

Image support depends on the selected model. If the model has no vision capability, TeleCode replies that it cannot read images and suggests switching with `/model`. Files larger than 8 MB are rejected. The conversation memory keeps a short `[1 image attached: image/jpeg]` placeholder instead of the raw bytes, so history does not bloat.

### Memory

Conversation memory is stored per chat in VS Code's extension state, so it survives window reloads and restarts. When a chat grows past 400 messages or roughly 200k tokens of text, TeleCode summarises the older turns into a running summary (keeping the most recent 40 messages verbatim) and every request carries that summary as context. Long transcripts are folded in chunks so nothing is dropped. Use `/compact` to do it on demand and `/clear` to forget everything.

#### Working set (remembered files)

`telecode_read_file`, `telecode_write_file` and `telecode_edit_file` record what they touched: the full file content (up to 40 KB per file, 40 files per chat) plus the modification time. Every following request carries that content, so the model does not have to read the same file again to answer the next question, and it is told which files it already has.

A compact activity log is kept as well (the last 25 tool calls with a one-line detail such as `read(src/tools.ts) -> ok`), so the model knows what work is already done.

- `/files` lists the remembered files with their age
- `/forget` drops the remembered files and activity log but keeps the conversation
- `/clear` drops everything for the chat
- `telecode.memory.fileContextChars` (default `24000`, `0` disables) caps how much remembered content is attached to each request

Files remembered this way live in extension state, not in your repository, and are capped by character count so the working set cannot grow without bound.

### From Telegram

Simply send any message to your bot! If AI integration is enabled, you'll get automatic responses from your configured Language Model. You can also send photos or image files and ask questions about them (see [Sending images to the bot](#sending-images-to-the-bot)).

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
- **`modelId`**: Model used for replies (`/model` switches it)
- **`memory.fileContextChars`**: Characters of remembered file content sent with each request
- **`agent.autoTools`** (default `true`): Only offer coding tools when a message looks like a workspace request. Set to `false` to always offer them.

### Tool use

Tools are only offered when the message looks like actual workspace work — a file path, a command, a code fragment, or a verb such as _fix_, _build_, _run_ or _search_. Conversational turns ("where are we now?", "thanks", "what's next?") are answered straight from the conversation and the remembered working set, so a simple question no longer turns into `git status` + directory listings.

When tools are used, the loop is bounded: a repeated identical tool call is skipped with a nudge, and after 6 tool rounds TeleCode makes one final call **without** tools so you always get an answer instead of silence.

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

# Bump patch version, package and install the extension user-wide
npm run install:local
```

`install:local` always bumps `version` first, so the new build shows up as an update in the Extensions view instead of silently replacing the old one.

## License

MIT
