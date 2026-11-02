import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { generateImage, generateVideo, getActiveChatId, queueMedia } from './media';

/**
 * TeleCode's own language model tools.
 *
 * Copilot's built-in tools cannot be used here: `copilot_createFile` needs the chat
 * stream ("Invalid stream") and `copilot_run_in_terminal` needs a tool invocation
 * token from a real ChatRequest ("Invocation context must be provided"). Tools that an
 * extension registers itself can be invoked from any custom flow, so TeleCode
 * implements the handful it needs.
 */

const MAX_READ_LINES = 2000;
const MAX_RESULT_CHARS = 12000;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

/** A file a tool read or wrote, recorded so later turns do not have to read it again. */
export interface TrackedFile {
    path: string;
    content: string;
    mtimeMs: number;
    kind: 'read' | 'written';
}

type FileTracker = (chatId: number, file: TrackedFile) => void;

let fileTracker: FileTracker | null = null;

/** Wiring hook: the extension points this at the chat's working-set memory. */
export function setFileTracker(tracker: FileTracker | null): void {
    fileTracker = tracker;
}

function trackFile(file: TrackedFile): void {
    if (!fileTracker) {
        return;
    }

    const chatId = getActiveChatId();
    if (chatId === null) {
        return;
    }

    try {
        fileTracker(chatId, file);
    } catch {
        // Bookkeeping must never break a tool call.
    }
}

function workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

/** Resolve a path and refuse anything outside the workspace. */
function resolveInWorkspace(target: string): string {
    const roots = workspaceRoots();
    if (roots.length === 0) {
        throw new Error('No workspace folder is open in VS Code.');
    }

    const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(roots[0], target);
    const inside = roots.some((root) => {
        const normalizedRoot = path.normalize(root);
        return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep);
    });

    if (!inside) {
        throw new Error(`Path is outside the workspace: ${target}`);
    }

    return resolved;
}

function truncate(text: string): string {
    if (text.length <= MAX_RESULT_CHARS) {
        return text;
    }
    return `${text.slice(0, MAX_RESULT_CHARS)}\n... [truncated ${text.length - MAX_RESULT_CHARS} characters]`;
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function relativeLabel(absolute: string): string {
    const roots = workspaceRoots();
    return roots.length > 0 ? path.relative(roots[0], absolute) || path.basename(absolute) : absolute;
}

interface ReadFileInput {
    filePath: string;
    path?: string;
    startLine?: number;
    endLine?: number;
}

interface WriteFileInput {
    filePath: string;
    path?: string;
    content: string;
}

interface ListDirInput {
    path?: string;
}

interface SearchInput {
    query: string;
    glob?: string;
    maxResults?: number;
}

interface RunCommandInput {
    command: string;
    timeoutSeconds?: number;
}

interface EditFileInput {
    filePath: string;
    oldText: string;
    newText: string;
    replaceAll?: boolean;
}

interface GenerateImageInput {
    prompt: string;
    width?: number;
    height?: number;
    model?: string;
}

interface GenerateVideoInput {
    prompt: string;
    durationSeconds?: number;
    width?: number;
    height?: number;
    model?: string;
}

const readFileTool: vscode.LanguageModelTool<ReadFileInput> = {
    async invoke(options) {
        const absolute = resolveInWorkspace(options.input.filePath ?? options.input.path ?? '');
        const stat = await fs.stat(absolute);
        if (stat.isDirectory()) {
            throw new Error(`${relativeLabel(absolute)} is a directory - use telecode_list_dir.`);
        }

        const raw = await fs.readFile(absolute, 'utf8');
        const lines = raw.split(/\r?\n/);
        const start = Math.max(1, Math.floor(options.input.startLine ?? 1));
        const requestedEnd = Math.floor(options.input.endLine ?? start + MAX_READ_LINES - 1);
        const end = Math.min(lines.length, Math.max(start, Math.min(requestedEnd, start + MAX_READ_LINES - 1)));

        // Remember the whole file, not just the slice, so the next turn need not read it again.
        trackFile({ path: relativeLabel(absolute), content: raw, mtimeMs: stat.mtimeMs, kind: 'read' });

        const body = lines
            .slice(start - 1, end)
            .map((line, index) => `${start + index}| ${line}`)
            .join('\n');

        return textResult(
            truncate(
                `${relativeLabel(absolute)} (${lines.length} lines total, showing ${start}-${end})\n${body}`
            )
        );
    }
};

const writeFileTool: vscode.LanguageModelTool<WriteFileInput> = {
    async invoke(options) {
        const absolute = resolveInWorkspace(options.input.filePath ?? options.input.path ?? '');
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, options.input.content, 'utf8');

        const stats = await fs.stat(absolute);
        const bytes = Buffer.byteLength(options.input.content, 'utf8');
        const lines = options.input.content.split(/\r?\n/).length;
        trackFile({
            path: relativeLabel(absolute),
            content: options.input.content,
            mtimeMs: stats.mtimeMs,
            kind: 'written'
        });
        return textResult(`Wrote ${bytes} bytes (${lines} lines) to ${relativeLabel(absolute)}.`);
    }
};

const listDirTool: vscode.LanguageModelTool<ListDirInput> = {
    async invoke(options) {
        const absolute = resolveInWorkspace(options.input.path ?? '.');
        const entries = await fs.readdir(absolute, { withFileTypes: true });

        const described = await Promise.all(
            entries.slice(0, 300).map(async (entry) => {
                const suffix = entry.isDirectory() ? '/' : await sizeSuffix(path.join(absolute, entry.name));
                return `${entry.name}${suffix}`;
            })
        );

        const more = entries.length > described.length ? `\n... ${entries.length - described.length} more entries` : '';
        return textResult(truncate(`${relativeLabel(absolute)}/\n${described.join('\n')}${more}`));
    }
};

async function sizeSuffix(absolute: string): Promise<string> {
    try {
        const stat = await fs.stat(absolute);
        return ` (${stat.size} bytes)`;
    } catch {
        return '';
    }
}

const searchTool: vscode.LanguageModelTool<SearchInput> = {
    async invoke(options) {
        const pattern = new RegExp(options.input.query, 'gim');
        const limit = Math.min(options.input.maxResults ?? MAX_SEARCH_MATCHES, MAX_SEARCH_MATCHES);
        const files = await vscode.workspace.findFiles(
            options.input.glob || '**/*',
            '**/{node_modules,.git,out,dist,build}/**',
            3000
        );

        const matches: string[] = [];
        for (const file of files) {
            if (matches.length >= limit) {
                break;
            }

            try {
                const stat = await fs.stat(file.fsPath);
                if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) {
                    continue;
                }

                const content = await fs.readFile(file.fsPath, 'utf8');
                if (content.includes('\u0000')) {
                    continue;
                }

                const lines = content.split(/\r?\n/);
                for (let index = 0; index < lines.length; index++) {
                    pattern.lastIndex = 0;
                    if (pattern.test(lines[index])) {
                        matches.push(`${vscode.workspace.asRelativePath(file)}:${index + 1}: ${lines[index].trim().slice(0, 300)}`);
                        if (matches.length >= limit) {
                            break;
                        }
                    }
                }
            } catch {
                // Unreadable/binary file: skip it.
            }
        }

        if (matches.length === 0) {
            return textResult(`No matches for ${options.input.query}.`);
        }

        return textResult(truncate(`${matches.length} match(es):\n${matches.join('\n')}`));
    }
};

const editFileTool: vscode.LanguageModelTool<EditFileInput> = {
    async invoke(options) {
        const input = options.input;
        const absolute = resolveInWorkspace(input.filePath ?? '');
        const original = await fs.readFile(absolute, 'utf8');

        if (!input.oldText) {
            throw new Error('"oldText" must not be empty - use telecode_write_file to create a file.');
        }

        const occurrences = original.split(input.oldText).length - 1;
        if (occurrences === 0) {
            throw new Error(`"oldText" was not found in ${relativeLabel(absolute)}. Read the file again to copy the exact text.`);
        }
        if (occurrences > 1 && !input.replaceAll) {
            throw new Error(
                `"oldText" appears ${occurrences} times in ${relativeLabel(absolute)}. Include more surrounding context or set replaceAll: true.`
            );
        }

        const updated = input.replaceAll
            ? original.split(input.oldText).join(input.newText)
            : original.replace(input.oldText, input.newText);
        await fs.writeFile(absolute, updated, 'utf8');

        const stats = await fs.stat(absolute);
        trackFile({ path: relativeLabel(absolute), content: updated, mtimeMs: stats.mtimeMs, kind: 'written' });

        return textResult(
            `Replaced ${input.replaceAll ? occurrences : 1} occurrence(s) in ${relativeLabel(absolute)} (${updated.length} chars now).`
        );
    }
};

/** Queue generated media so the extension can send it to the Telegram chat. */
function deliverToActiveChat(kind: 'image' | 'video', url: string, prompt: string): string {
    const chatId = getActiveChatId();
    if (chatId === null) {
        return `Generated ${kind}: ${url}`;
    }

    queueMedia(chatId, { kind, url, prompt });
    return `Generated ${kind} for "${prompt}". It will be sent to the Telegram chat; do not paste the URL unless asked.`;
}

const generateImageTool: vscode.LanguageModelTool<GenerateImageInput> = {
    async invoke(options) {
        const input = options.input;
        if (!input.prompt?.trim()) {
            throw new Error('"prompt" is required.');
        }

        const media = await generateImage(input.prompt.trim(), {
            width: input.width,
            height: input.height,
            model: input.model
        });

        return textResult(deliverToActiveChat('image', media.url, media.prompt));
    }
};

const generateVideoTool: vscode.LanguageModelTool<GenerateVideoInput> = {
    async invoke(options) {
        const input = options.input;
        if (!input.prompt?.trim()) {
            throw new Error('"prompt" is required.');
        }

        const media = await generateVideo(input.prompt.trim(), {
            width: input.width,
            height: input.height,
            durationSeconds: input.durationSeconds,
            model: input.model
        });

        return textResult(deliverToActiveChat('video', media.url, media.prompt));
    }
};

const runCommandTool: vscode.LanguageModelTool<RunCommandInput> = {
    async invoke(options) {
        const roots = workspaceRoots();
        if (roots.length === 0) {
            throw new Error('No workspace folder is open in VS Code.');
        }

        const command = options.input.command;
        const timeoutMs = Math.min(Math.max(options.input.timeoutSeconds ?? 120, 1), 600) * 1000;
        const isWindows = process.platform === 'win32';

        const file = isWindows ? 'powershell.exe' : '/bin/bash';
        const args = isWindows
            ? ['-NoProfile', '-NonInteractive', '-Command', command]
            : ['-lc', command];

        const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | string }>(
            (resolve) => {
                execFile(
                    file,
                    args,
                    { cwd: roots[0], timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
                    (error, out, err) => {
                        const exitCode = (error as NodeJS.ErrnoException & { code?: number | string })?.code ?? 0;
                        resolve({ stdout: out?.toString() ?? '', stderr: err?.toString() ?? '', code: exitCode });
                    }
                );
            }
        );

        const sections = [`$ ${command}`, `(cwd: ${roots[0]})`, `exit code: ${code}`];
        if (stdout.trim()) {
            sections.push(`stdout:\n${stdout.trimEnd()}`);
        }
        if (stderr.trim()) {
            sections.push(`stderr:\n${stderr.trimEnd()}`);
        }
        if (!stdout.trim() && !stderr.trim()) {
            sections.push('(no output)');
        }

        return textResult(truncate(sections.join('\n')));
    }
};

/** One of TeleCode's own tools: descriptor for the model plus the executor. */
export interface TelecodeToolDefinition {
    name: string;
    description: string;
    inputSchema: object;
    tool: vscode.LanguageModelTool<never>;
}

const PATH_PROPERTY = {
    type: 'string',
    description: 'Workspace-relative or absolute path inside the workspace.'
};

/**
 * The tools TeleCode offers the model. They are executed in-process, so they work
 * even though Copilot's own tools need a real chat request context.
 */
export const telecodeTools: TelecodeToolDefinition[] = [
    {
        name: 'telecode_read_file',
        description: 'Read a text file from the workspace, with 1-based line numbers.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: PATH_PROPERTY,
                startLine: { type: 'number', description: 'First line to return (1-based).' },
                endLine: { type: 'number', description: 'Last line to return (inclusive).' }
            },
            required: ['filePath']
        },
        tool: readFileTool as unknown as vscode.LanguageModelTool<never>
    },
    {
        name: 'telecode_write_file',
        description: 'Create or overwrite a file in the workspace with the given content.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: PATH_PROPERTY,
                content: { type: 'string', description: 'Full file content to write.' }
            },
            required: ['filePath', 'content']
        },
        tool: writeFileTool as unknown as vscode.LanguageModelTool<never>
    },
    {
        name: 'telecode_list_dir',
        description: 'List the entries of a workspace directory.',
        inputSchema: {
            type: 'object',
            properties: { path: { ...PATH_PROPERTY, description: 'Directory path, defaults to the workspace root.' } }
        },
        tool: listDirTool as unknown as vscode.LanguageModelTool<never>
    },
    {
        name: 'telecode_search',
        description: 'Search file contents in the workspace with a regular expression.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Regular expression to search for.' },
                glob: { type: 'string', description: 'Optional glob filter, e.g. "**/*.ts".' },
                maxResults: { type: 'number', description: 'Maximum number of matches.' }
            },
            required: ['query']
        },
        tool: searchTool as unknown as vscode.LanguageModelTool<never>
    },
    {
        name: 'telecode_edit_file',
        description:
            'Replace an exact snippet in a workspace file. Prefer this over rewriting a whole file. Fails when oldText is missing or ambiguous.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: PATH_PROPERTY,
                oldText: { type: 'string', description: 'Exact text to replace, copied from the file.' },
                newText: { type: 'string', description: 'Replacement text.' },
                replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' }
            },
            required: ['filePath', 'oldText', 'newText']
        },
        tool: editFileTool as unknown as vscode.LanguageModelTool<never>
    },
    {
        name: 'telecode_generate_image',
        description:
            'Generate an image from a text prompt with the configured media API (e.g. Runware) and send it to the Telegram chat. Use when the user asks for a picture, logo, illustration or diagram image.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
                width: { type: 'number', description: 'Width in pixels (128-2048, default 1024).' },
                height: { type: 'number', description: 'Height in pixels (128-2048, default 1024).' },
                model: { type: 'string', description: 'Optional model override, e.g. "runware:100@1".' }
            },
            required: ['prompt']
        },
        tool: generateImageTool as unknown as vscode.LanguageModelTool<never>
    },
    {
        name: 'telecode_generate_video',
        description:
            'Generate a short video from a text prompt with the configured media API (e.g. Runware) and send it to the Telegram chat.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Detailed description of the video to generate.' },
                durationSeconds: { type: 'number', description: 'Clip length in seconds (1-30, default 5).' },
                width: { type: 'number', description: 'Width in pixels (default 1280).' },
                height: { type: 'number', description: 'Height in pixels (default 720).' },
                model: { type: 'string', description: 'Optional model override.' }
            },
            required: ['prompt']
        },
        tool: generateVideoTool as unknown as vscode.LanguageModelTool<never>
    },
    {
        name: 'telecode_run_command',
        description:
            'Run a shell command in the workspace root (PowerShell on Windows, bash elsewhere) and return stdout, stderr and the exit code. Use for git, build and test commands.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The command line to execute.' },
                timeoutSeconds: { type: 'number', description: 'Timeout in seconds (1-600, default 120).' }
            },
            required: ['command']
        },
        tool: runCommandTool as unknown as vscode.LanguageModelTool<never>
    }
];

/** Execute one of TeleCode's tools by name. Returns undefined when the name is unknown. */
export async function invokeTelecodeTool(name: string, input: unknown): Promise<vscode.LanguageModelToolResult | undefined> {
    const definition = telecodeTools.find((candidate) => candidate.name === name);
    if (!definition) {
        return undefined;
    }
    return (
        (await definition.tool.invoke(
            { input: input as never, toolInvocationToken: undefined },
            new vscode.CancellationTokenSource().token
        )) ?? undefined
    );
}

/** Register TeleCode's tools. Safe to call once during activation. */
export function registerTelecodeTools(context: vscode.ExtensionContext): void {
    if (typeof vscode.lm?.registerTool !== 'function') {
        return;
    }

    for (const definition of telecodeTools) {
        try {
            context.subscriptions.push(
                vscode.lm.registerTool(definition.name, definition.tool as vscode.LanguageModelTool<object>)
            );
        } catch {
            // Tool could not be registered (for example when older VS Code lacks the contribution).
        }
    }
}
