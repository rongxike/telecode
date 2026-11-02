import * as vscode from 'vscode';

/** A single stored turn. Kept serialisable so it can live in extension globalState. */
export interface StoredMessage {
    role: 'user' | 'assistant';
    text: string;
    at: number;
}

export interface MemoryStats {
    messages: number;
    chars: number;
    summaryChars: number;
}

/** A workspace file the chat already looked at, kept so the model need not read it again. */
export interface FileMemory {
    /** Workspace-relative path, as it was shown to the model. */
    path: string;
    /** Full size in characters at capture time. */
    chars: number;
    /** Modification time at capture, so stale entries can be spotted. */
    mtimeMs: number;
    /** When the entry was captured or refreshed. */
    at: number;
    kind: 'read' | 'written';
    truncated: boolean;
    content: string;
}

/** One tool call the bot already made in this chat. */
export interface ToolActivity {
    tool: string;
    detail: string;
    ok: boolean;
    at: number;
    /** Short preview of what the tool returned, so later turns need not re-run it. */
    result?: string;
}

/** Compact "5 min ago" style age used in prompts and in `/files`. */
export function formatAge(ms: number): string {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    return `${Math.round(hours / 24)} d ago`;
}

const KEY_PREFIX = 'telecode.memory';
const CHATS_KEY = `${KEY_PREFIX}.chats`;

/**
 * Per-chat conversation memory that survives window reloads.
 *
 * Messages are persisted in `globalState`; once the transcript grows past the
 * size limits it is folded into a running summary (compaction).
 */
export class ConversationMemory {
    /** Compact once the transcript holds more than this many messages. */
    static readonly MAX_MESSAGES = 400;
    /** Compact once the transcript plus summary exceeds this many characters (~200k tokens). */
    static readonly MAX_CHARS = 800000;
    /** Messages kept verbatim after a compaction. */
    static readonly KEEP_RECENT = 40;
    /** Safety valve so a failing compaction can never grow memory without bound. */
    static readonly HARD_CAP = 800;
    /** Files remembered per chat (newest kept). */
    static readonly MAX_FILES = 40;
    /** Characters kept per remembered file; longer files are stored truncated. */
    static readonly MAX_FILE_CHARS = 40000;
    /** Total characters of remembered file content per chat. */
    static readonly MAX_FILES_CHARS = 240000;
    /** Tool calls kept in the activity log per chat. */
    static readonly MAX_ACTIVITY = 25;

    private readonly messages = new Map<number, StoredMessage[]>();
    private readonly summaries = new Map<number, string>();
    private readonly files = new Map<number, FileMemory[]>();
    private readonly activities = new Map<number, ToolActivity[]>();
    private knownChats: number[];

    constructor(private readonly context: vscode.ExtensionContext) {
        this.knownChats = this.context.globalState.get<number[]>(CHATS_KEY, []);
    }

    private messagesKey(chatId: number): string {
        return `${KEY_PREFIX}.${chatId}.messages`;
    }

    private summaryKey(chatId: number): string {
        return `${KEY_PREFIX}.${chatId}.summary`;
    }

    private filesKey(chatId: number): string {
        return `${KEY_PREFIX}.${chatId}.files`;
    }

    private activityKey(chatId: number): string {
        return `${KEY_PREFIX}.${chatId}.activity`;
    }

    getMessages(chatId: number): StoredMessage[] {
        if (!this.messages.has(chatId)) {
            const stored = this.context.globalState.get<StoredMessage[]>(this.messagesKey(chatId), []);
            this.messages.set(chatId, Array.isArray(stored) ? stored : []);
        }
        return this.messages.get(chatId)!;
    }

    getSummary(chatId: number): string {
        if (!this.summaries.has(chatId)) {
            this.summaries.set(chatId, this.context.globalState.get<string>(this.summaryKey(chatId), ''));
        }
        return this.summaries.get(chatId)!;
    }

    stats(chatId: number): MemoryStats {
        const messages = this.getMessages(chatId);
        return {
            messages: messages.length,
            chars: messages.reduce((total, message) => total + message.text.length, 0),
            summaryChars: this.getSummary(chatId).length
        };
    }

    needsCompaction(chatId: number): boolean {
        const stats = this.stats(chatId);
        return (
            stats.messages > ConversationMemory.MAX_MESSAGES ||
            stats.chars + stats.summaryChars > ConversationMemory.MAX_CHARS
        );
    }

    async append(chatId: number, ...entries: Array<Pick<StoredMessage, 'role' | 'text'>>): Promise<void> {
        const list = this.getMessages(chatId);
        const now = Date.now();
        list.push(...entries.map((entry) => ({ ...entry, at: now })));

        if (list.length > ConversationMemory.HARD_CAP) {
            list.splice(0, list.length - ConversationMemory.HARD_CAP);
        }

        await this.persistMessages(chatId);
    }

    async setCompacted(chatId: number, summary: string, kept: StoredMessage[]): Promise<void> {
        this.messages.set(chatId, kept);
        this.summaries.set(chatId, summary);
        await this.persistMessages(chatId);
        await this.persistSummary(chatId);
    }

    async clear(chatId: number): Promise<void> {
        this.messages.delete(chatId);
        this.summaries.delete(chatId);
        this.files.delete(chatId);
        this.activities.delete(chatId);
        await this.context.globalState.update(this.messagesKey(chatId), undefined);
        await this.context.globalState.update(this.summaryKey(chatId), undefined);
        await this.context.globalState.update(this.filesKey(chatId), undefined);
        await this.context.globalState.update(this.activityKey(chatId), undefined);
    }

    /** Chat ids that ever stored memory, including ones not loaded in this session. */
    getChatIds(): number[] {
        const ids = new Set<number>([
            ...this.knownChats,
            ...this.messages.keys(),
            ...this.summaries.keys(),
            ...this.files.keys(),
            ...this.activities.keys()
        ]);
        return [...ids];
    }

    async clearAll(): Promise<void> {
        for (const chatId of this.getChatIds()) {
            await this.clear(chatId);
        }
        this.knownChats = [];
        await this.context.globalState.update(CHATS_KEY, []);
    }

    /** Files this chat has read or written, oldest first. */
    getFiles(chatId: number): FileMemory[] {
        if (!this.files.has(chatId)) {
            const stored = this.context.globalState.get<FileMemory[]>(this.filesKey(chatId), []);
            this.files.set(chatId, Array.isArray(stored) ? stored : []);
        }
        return this.files.get(chatId)!;
    }

    fileStats(chatId: number): { count: number; chars: number } {
        const files = this.getFiles(chatId);
        return {
            count: files.length,
            chars: files.reduce((total, file) => total + file.content.length, 0)
        };
    }

    /**
     * Remember a file's current content so later turns can reason about it without
     * calling `telecode_read_file` again.
     */
    async rememberFile(
        chatId: number,
        file: { path: string; content: string; mtimeMs: number; kind: 'read' | 'written' }
    ): Promise<void> {
        const list = this.getFiles(chatId).filter((entry) => entry.path !== file.path);
        const truncated = file.content.length > ConversationMemory.MAX_FILE_CHARS;

        list.push({
            path: file.path,
            chars: file.content.length,
            mtimeMs: file.mtimeMs,
            at: Date.now(),
            kind: file.kind,
            truncated,
            content: truncated ? file.content.slice(0, ConversationMemory.MAX_FILE_CHARS) : file.content
        });

        let total = list.reduce((sum, entry) => sum + entry.content.length, 0);
        while (list.length > ConversationMemory.MAX_FILES || (total > ConversationMemory.MAX_FILES_CHARS && list.length > 1)) {
            const dropped = list.shift();
            total -= dropped ? dropped.content.length : 0;
        }

        this.files.set(chatId, list);
        await this.context.globalState.update(this.filesKey(chatId), list);
        await this.touchChat(chatId);
    }

    /** Drop the remembered files but keep the conversation transcript. */
    async forgetFiles(chatId: number): Promise<void> {
        this.files.delete(chatId);
        this.activities.delete(chatId);
        await this.context.globalState.update(this.filesKey(chatId), undefined);
        await this.context.globalState.update(this.activityKey(chatId), undefined);
    }

    /** Tool calls this chat already made, oldest first. */
    getActivity(chatId: number): ToolActivity[] {
        if (!this.activities.has(chatId)) {
            const stored = this.context.globalState.get<ToolActivity[]>(this.activityKey(chatId), []);
            this.activities.set(chatId, Array.isArray(stored) ? stored : []);
        }
        return this.activities.get(chatId)!;
    }

    /** Record a tool call so the next turn knows the work is already done. */
    recordTool(chatId: number, activity: Omit<ToolActivity, 'at'>): void {
        const list = this.getActivity(chatId);
        list.push({ ...activity, at: Date.now() });

        if (list.length > ConversationMemory.MAX_ACTIVITY) {
            list.splice(0, list.length - ConversationMemory.MAX_ACTIVITY);
        }

        void Promise.resolve(this.context.globalState.update(this.activityKey(chatId), list))
            .then(() => this.touchChat(chatId))
            .catch(() => undefined);
    }

    /** One short line per recent tool call, newest last. */
    buildActivityContext(chatId: number, limit = 12): string {
        const activity = this.getActivity(chatId);
        if (activity.length === 0) {
            return '';
        }

        const now = Date.now();
        const lines = activity
            .slice(-limit)
            .map((entry) => {
                const status = entry.ok ? 'ok' : 'failed';
                const head = `- ${entry.tool}(${entry.detail}) -> ${status}, ${formatAge(now - entry.at)}`;
                return entry.result ? `${head}\n  result: ${entry.result}` : head;
            });

        return [
            'Tools already run in this conversation, with the start of their output. Reuse these results instead of calling the same tool again:',
            ...lines
        ].join('\n');
    }

    /**
     * Render the working set for the next request: newest files first, up to
     * `budgetChars` characters of content.
     */
    buildFileContext(chatId: number, budgetChars: number): string {
        const files = this.getFiles(chatId);
        if (files.length === 0 || budgetChars <= 0) {
            return '';
        }

        const header = [
            'Files this conversation already read or edited. Their content is below, so do NOT call telecode_read_file for them again',
            'unless the user says the file changed, a tool or shell command rewrote it in the meantime, or you need lines beyond a truncation note.',
            'Prefer editing from this content and call telecode_read_file only for files listed as truncated or not listed here.'
        ].join(' ');

        const sections: string[] = [];
        let used = header.length;

        for (const file of [...files].reverse()) {
            const size = Math.max(1, Math.round(file.chars / 1024));
            const label = `=== ${file.path} [${file.kind} ${formatAge(Date.now() - file.at)}, ${size} KB]${file.truncated ? ' (truncated - read with startLine/endLine for the rest)' : ''} ===`;
            const remaining = budgetChars - used - label.length;
            if (remaining < 200) {
                break;
            }

            const body =
                file.content.length > remaining
                    ? `${file.content.slice(0, remaining)}\n... [truncated for length]`
                    : file.content;

            sections.push(`${label}\n${body}`);
            used += label.length + body.length;
        }

        return sections.length === 0 ? '' : `${header}\n\n${sections.join('\n\n')}`;
    }

    private async persistMessages(chatId: number): Promise<void> {
        await this.context.globalState.update(this.messagesKey(chatId), this.getMessages(chatId));
        await this.touchChat(chatId);
    }

    private async persistSummary(chatId: number): Promise<void> {
        await this.context.globalState.update(this.summaryKey(chatId), this.getSummary(chatId));
    }

    private async touchChat(chatId: number): Promise<void> {
        if (!this.knownChats.includes(chatId)) {
            this.knownChats = [...this.knownChats, chatId];
            await this.context.globalState.update(CHATS_KEY, this.knownChats);
        }
    }
}
