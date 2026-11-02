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

    private readonly messages = new Map<number, StoredMessage[]>();
    private readonly summaries = new Map<number, string>();
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
        await this.context.globalState.update(this.messagesKey(chatId), undefined);
        await this.context.globalState.update(this.summaryKey(chatId), undefined);
    }

    /** Chat ids that ever stored memory, including ones not loaded in this session. */
    getChatIds(): number[] {
        const ids = new Set<number>([...this.knownChats, ...this.messages.keys(), ...this.summaries.keys()]);
        return [...ids];
    }

    async clearAll(): Promise<void> {
        for (const chatId of this.getChatIds()) {
            await this.clear(chatId);
        }
        this.knownChats = [];
        await this.context.globalState.update(CHATS_KEY, []);
    }

    private async persistMessages(chatId: number): Promise<void> {
        await this.context.globalState.update(this.messagesKey(chatId), this.getMessages(chatId));

        if (!this.knownChats.includes(chatId)) {
            this.knownChats = [...this.knownChats, chatId];
            await this.context.globalState.update(CHATS_KEY, this.knownChats);
        }
    }

    private async persistSummary(chatId: number): Promise<void> {
        await this.context.globalState.update(this.summaryKey(chatId), this.getSummary(chatId));
    }
}
