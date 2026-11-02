# TeleCode Setup Guide

TeleCode bridges VS Code and Telegram: you message a Telegram bot, and it replies using
a language model that can read, edit, search and run commands in your workspace.

- Extension version: **0.1.10** · VS Code **1.95.0+**
- Two backends: **VS Code language models** (Copilot etc.) or any **OpenAI-compatible API**

---

## 1. Prerequisites

1. **VS Code 1.95 or newer.**
2. **A model source** (pick one):
   - A VS Code language model provider installed and signed in (GitHub Copilot Chat is the
     common one) — required if `telecode.enableAIIntegration` is on and the vendor backend is off.
   - **or** an API key for an OpenAI-compatible endpoint (DeepSeek, OpenRouter, Ollama, …).
3. **A Telegram account** (mobile or desktop app).

---

## 2. Install the extension

From the repo:

```powershell
npm install
npm run compile
npm run install:local     # bumps version, packages telecode.vsix, installs it
```

Notes:
- `install:local` bumps the patch version first, so the build shows up as an *update* in the
  Extensions view rather than silently replacing the old one.
- To install a prebuilt bundle instead: `code --install-extension telecode.vsix --force`.
- After installing, reload the window (`Developer: Reload Window`).

---

## 3. Create the Telegram bot

1. In Telegram, open [@BotFather](https://t.me/botfather).
2. Send `/newbot`, choose a name and a username ending in `bot`.
3. Copy the token — format is `<digits>:<35-ish chars>`, e.g. `123456789:AAG...`.

> TeleCode rejects tokens that don't match `^\d{6,}:[A-Za-z0-9_-]{30,}$` and tells you which
> settings scope the bad value came from. If you get that error, a workspace-level override is
> usually shadowing your user setting.

---

## 4. Configure the token in VS Code

1. `Ctrl+Shift+P` → **TeleCode: Configure Bot Token**
2. Paste the token (input is masked; surrounding quotes/whitespace are stripped).
3. The value is written to **user settings** as `telecode.botToken`.

Equivalent `settings.json`:

```json
{
  "telecode.botToken": "123456789:AAG...",
  "telecode.allowedChatIds": [123456789],
  "telecode.autoStart": true,
  "telecode.enableAIIntegration": true
}
```

> The bot token lives in `settings.json` in plain text. Don't commit it — keep it in user
> settings, not `.vscode/settings.json`. (Only the *vendor API key* uses Secret Storage.)

---

## 5. Start the bot and authorize your chat

1. `Ctrl+Shift+P` → **TeleCode: Start Bot**.
2. In Telegram, open your bot and send **`/start`**.
3. The bot replies with **your Chat ID** (`/start` is answered before the allow-list check, so it
   works even before you're authorized).
4. Add that ID to `telecode.allowedChatIds` in Settings (`Ctrl+,` → search `telecode.allowedChatIds`),
   e.g. `[123456789]`.
5. Send any message — you should get an AI reply.

**Security note:** while `allowedChatIds` is **empty, everyone who finds the bot can drive your
VS Code**. Set it as soon as you know your ID. Unauthorized chats get
`⛔ Unauthorized.` and the attempt is logged.

---

## 6. Choose the model backend

### Option A — VS Code language models (default)

- Keep `telecode.vendor.enabled` = `false`.
- Keep `telecode.enableAIIntegration` = `true`.
- Pick a model with **TeleCode: Select AI Model** (Command Palette), or `/model` in Telegram:
  - `/model` → numbered list of what VS Code offers
  - `/model 3` → switch to entry 3
- `telecode.modelId` accepts a model `id` (`deepseek-v4-flash`), a `vendor/family` pair
  (`deepseek/deepseek`), or a bare family name. Empty = first available model.
- The choice is also mirrored into extension state, so a stale settings schema can't block switching.

### Option B — OpenAI-compatible vendor API

```json
{
  "telecode.vendor.enabled": true,
  "telecode.vendor.baseUrl": "https://api.deepseek.com",
  "telecode.vendor.model": "deepseek-chat"
}
```

Then run **TeleCode: Configure Vendor API Key** and paste the key.

- Stored in VS Code **Secret Storage**, never in `settings.json`.
- The command validates the key against `GET {baseUrl}/models` and reports how many models the
  endpoint offers; a failed check is a warning, not a rejection.
- `baseUrl` is used as-is (trailing slashes trimmed) — include `/v1` for providers that need it.
- When enabled, the vendor backend wins over VS Code models. Same tool set is exposed through
  OpenAI function-calling.
- `/status` shows the backend, model, base URL and whether a key is stored.

---

## 7. Recommended settings reference

| Setting | Default | Purpose |
|---|---|---|
| `telecode.botToken` | `""` | Telegram Bot API token |
| `telecode.allowedChatIds` | `[]` | Allow-list of chat IDs. **Empty = open to anyone** |
| `telecode.autoStart` | `false` | Start polling when VS Code starts |
| `telecode.enableAIIntegration` | `true` | Auto-reply to Telegram messages |
| `telecode.modelId` | `""` | Model id / `vendor/family` / family name |
| `telecode.vendor.enabled` | `false` | Use the OpenAI-compatible backend |
| `telecode.vendor.baseUrl` | `https://api.deepseek.com` | Endpoint base URL |
| `telecode.vendor.model` | `deepseek-chat` | Model name sent to the vendor |

---

## 8. Using it

### Telegram commands

| Command | Effect |
|---|---|
| `/start` | Show your chat ID (works before authorization) |
| `/help` or `/commands` | List every command |
| `/status` | Backend, model, API-key presence, memory usage, bot state |
| `/model` | List available models |
| `/model <n>` | Switch to model *n* |
| `/compact` | Fold older turns into a summary now |
| `/clear` | Delete this chat's history and summary |

Anything else is sent to the model.

### VS Code commands

- **TeleCode: Start Bot** / **TeleCode: Stop Bot**
- **TeleCode: Send Message** — prompt for text, send to every allowed chat ID
- **TeleCode: Send to Active Chat** — programmatic send (used by other extensions)
- **TeleCode: Test Send** — send a test message to the active chat
- **TeleCode: Clear Conversation History** — clears memory and summaries for *all* chats
- **TeleCode: Select AI Model**, **TeleCode: Configure Bot Token**, **TeleCode: Configure Vendor API Key**

### Tools the model can use

`telecode_read_file`, `telecode_write_file`, `telecode_edit_file`, `telecode_list_dir`,
`telecode_search`, `telecode_run_command`. All are workspace-scoped — paths outside the
workspace folder are refused.

Limits: reads capped at 2000 lines, search at 200 matches / 1 MB per file, command timeout
1–600 s (default 120).

> Copilot's built-in tools (`copilot_createFile`, `copilot_run_in_terminal`, …) can't run from a
> non-chat flow. TeleCode ships its own replacements; if a chat-panel-only tool is invoked it is
> disabled for the session and the model is told to use the `telecode_*` tools instead.

### Memory and compaction

- History is stored per chat in extension `globalState`, so it survives window reloads.
- Compaction triggers above **400 messages** or **~800k chars** (≈200k tokens): older turns are
  folded into a running summary, the **40** most recent messages stay verbatim, and long
  transcripts are summarised in chunks.
- Hard cap of 800 stored messages per chat as a safety valve.
- `/compact` runs it on demand; `/clear` forgets everything for that chat.

---

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| **Start Bot** says token not configured | Run **TeleCode: Configure Bot Token** |
| "Invalid bot token in …" | Placeholder/truncated token, or a workspace override shadowing user settings |
| Bot replies `⛔ Unauthorized` | Add your chat ID to `telecode.allowedChatIds` |
| No reply at all | Bot running? `/status` in Telegram. Logs: **View → Output → TeleCode** |
| "The selected model is not available" | Re-pick with **TeleCode: Select AI Model** or `/model <n>` |
| "No permission to use the selected model" | Model access isn't granted to the extension — check Copilot/extension settings |
| replies but no tools | Language model lacks tool support, or the tool is chat-panel-only (see logs) |
| Vendor backend silent | `/status` → key stored? `baseUrl` reachable and includes `/v1` if needed? |

The **TeleCode** output channel logs incoming messages, tool calls, compaction stats and errors —
it is the first place to look.

---

## 10. Extension API

```typescript
const ext = vscode.extensions.getExtension('local.telecode');
const api = ext?.exports;

if (api?.isInTelegramContext()) {
  await api.sendToActiveTelegramChat('Hello from my extension!');
}

// or, via command:
await vscode.commands.executeCommand('telecode.sendToActiveChat', 'My message');
```

Both return `false` when the bot isn't running or no chat is active yet.

---

## License

MIT
