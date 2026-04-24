import { OpenClawPluginApi } from 'openclaw/plugin-sdk';

/**
 * Per-agent memory isolation helpers.
 *
 * Multi-agent setups write/read from separate userId namespaces
 * automatically via sessionKey routing.
 */
/**
 * Returns true if the session trigger is non-interactive and memory
 * hooks should be skipped entirely.
 *
 * Also detects cron-style session keys (e.g. "agent:main:cron:<id>")
 * as a fallback when the trigger field is not set.
 */
declare function isNonInteractiveTrigger(trigger: string | undefined, sessionKey: string | undefined): boolean;
/**
 * Returns true if the session key indicates a subagent (ephemeral) session.
 * Subagent UUIDs are random per-spawn, so their namespaces are always empty
 * on recall and orphaned after capture.
 */
declare function isSubagentSession(sessionKey: string | undefined): boolean;
/**
 * Parse an agent ID from a session key.
 *
 * OpenClaw session key formats:
 *   - Main agent:  "agent:main:main"
 *   - Subagent:    "agent:main:subagent:<uuid>"
 *   - Named agent: "agent:<agentId>:<session>"
 *
 * Returns the subagent UUID for subagent sessions, the agentId for
 * non-"main" named agents, or undefined for the main agent session.
 */
declare function extractAgentId(sessionKey: string | undefined): string | undefined;
/**
 * Derive the effective user_id from a session key, namespacing per-agent.
 * Falls back to baseUserId when the session is not agent-scoped.
 */
declare function effectiveUserId(baseUserId: string, sessionKey?: string): string;
/** Build a user_id for an explicit agentId (e.g. from tool params). */
declare function agentUserId(baseUserId: string, agentId: string): string;
/**
 * Resolve user_id with priority: explicit agentId > explicit userId > session-derived > configured.
 */
declare function resolveUserId(baseUserId: string, opts: {
    agentId?: string;
    userId?: string;
}, currentSessionId?: string): string;

/**
 * Pre-extraction message filtering: noise detection, content stripping,
 * generic assistant detection, truncation, and deduplication.
 */
/**
 * Check whether a message's content is entirely noise (cron heartbeats,
 * single-word acknowledgments, system routing metadata, etc.).
 */
declare function isNoiseMessage(content: string): boolean;
/**
 * Check whether an assistant message is a generic acknowledgment with no
 * extractable facts (e.g. "I see you've shared an update. How can I help?").
 * Only applies to short assistant messages — longer responses likely contain
 * substantive content even if they start with a generic opener.
 */
declare function isGenericAssistantMessage(content: string): boolean;
/**
 * Remove embedded noise fragments (routing metadata, media boilerplate,
 * compaction audit blocks) from a message while preserving the useful content.
 */
declare function stripNoiseFromContent(content: string): string;
/**
 * Full pre-extraction pipeline: drop noise messages, strip noise fragments,
 * and truncate remaining messages to a reasonable length.
 */
declare function filterMessagesForExtraction(messages: Array<{
    role: string;
    content: string;
}>): Array<{
    role: string;
    content: string;
}>;

/**
 * Shared type definitions for the OpenClaw Mem0 plugin.
 */
type Mem0Mode = "platform" | "open-source";
type Mem0Config = {
    mode: Mem0Mode;
    apiKey?: string;
    baseUrl?: string;
    customInstructions: string;
    customCategories: Record<string, string>;
    customPrompt?: string;
    oss?: {
        embedder?: {
            provider: string;
            config: Record<string, unknown>;
        };
        vectorStore?: {
            provider: string;
            config: Record<string, unknown>;
        };
        llm?: {
            provider: string;
            config: Record<string, unknown>;
        };
        historyDbPath?: string;
        disableHistory?: boolean;
    };
    userId: string;
    autoCapture: boolean;
    autoRecall: boolean;
    searchThreshold: number;
    topK: number;
    needsSetup?: boolean;
    skills?: SkillsConfig;
};
interface AddOptions {
    user_id: string;
    run_id?: string;
    custom_instructions?: string;
    custom_categories?: Array<Record<string, string>>;
    output_format?: string;
    source?: string;
    infer?: boolean;
    deduced_memories?: string[];
    metadata?: Record<string, unknown>;
    expiration_date?: string;
    immutable?: boolean;
}
interface SearchOptions {
    user_id: string;
    run_id?: string;
    top_k?: number;
    threshold?: number;
    limit?: number;
    keyword_search?: boolean;
    reranking?: boolean;
    filter_memories?: boolean;
    categories?: string[];
    filters?: Record<string, unknown>;
    source?: string;
}
interface CategoryConfig {
    importance: number;
    ttl: string | null;
    immutable?: boolean;
}
interface SkillsConfig {
    triage?: {
        enabled?: boolean;
        importanceThreshold?: number;
        credentialPatterns?: string[];
    };
    recall?: {
        /** Master switch. false = no auto-recall regardless of strategy. */
        enabled?: boolean;
        /** Controls auto-recall behavior. Only consulted when enabled !== false.
         *  "smart" (default): long-term search only, 1 search/turn.
         *  "manual": zero plugin searches, agent controls all search.
         *  "always": long-term + session search, 2 searches/turn. */
        strategy?: "always" | "smart" | "manual";
        tokenBudget?: number;
        maxMemories?: number;
        rerank?: boolean;
        keywordSearch?: boolean;
        filterMemories?: boolean;
        threshold?: number;
        identityAlwaysInclude?: boolean;
        categoryOrder?: string[];
    };
    dream?: {
        enabled?: boolean;
        /** Enable automatic triggering based on activity gates. Default: true when dream enabled. */
        auto?: boolean;
        /** Minimum hours between consolidations. Default: 24. */
        minHours?: number;
        /** Minimum interactive sessions before triggering. Default: 5. */
        minSessions?: number;
        /** Minimum total memories to justify consolidation. Default: 20. */
        minMemories?: number;
    };
    domain?: string;
    customRules?: {
        include?: string[];
        exclude?: string[];
    };
    categories?: Record<string, CategoryConfig>;
}
interface ListOptions {
    user_id: string;
    run_id?: string;
    page_size?: number;
    source?: string;
}
interface MemoryItem {
    id: string;
    memory: string;
    user_id?: string;
    score?: number;
    categories?: string[];
    metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
}
interface AddResultItem {
    id: string;
    memory: string;
    event: "ADD" | "UPDATE" | "DELETE" | "NOOP";
}
interface AddResult {
    results: AddResultItem[];
}
interface Mem0Provider {
    add(messages: Array<{
        role: string;
        content: string;
    }>, options: AddOptions): Promise<AddResult>;
    search(query: string, options: SearchOptions): Promise<MemoryItem[]>;
    get(memoryId: string): Promise<MemoryItem>;
    getAll(options: ListOptions): Promise<MemoryItem[]>;
    update(memoryId: string, text: string): Promise<void>;
    delete(memoryId: string): Promise<void>;
    deleteAll(userId: string): Promise<void>;
    history(memoryId: string): Promise<Array<{
        id: string;
        old_memory: string;
        new_memory: string;
        event: string;
        created_at: string;
    }>>;
}

/**
 * Configuration parsing and default instructions/categories.
 *
 * NOTE: This module must NOT import from `node:fs` or `node:fs/promises`.
 * All filesystem operations are centralized in fs-safe.ts.
 */

/** Shape accepted by parse() for the openclaw.json plugin auth fallback. */
interface FileConfig {
    apiKey?: string;
    baseUrl?: string;
}
declare const mem0ConfigSchema: {
    parse(value: unknown, fileConfig?: FileConfig): Mem0Config;
};

/**
 * Mem0 provider implementations: Platform (cloud) and OSS (self-hosted).
 */

declare function createProvider(cfg: Mem0Config, api: OpenClawPluginApi): Mem0Provider;

/**
 * OpenClaw Memory (Mem0) Plugin
 *
 * Long-term memory via Mem0 — supports both the Mem0 platform
 * and the open-source self-hosted SDK. Uses the official `mem0ai` package.
 *
 * Features:
 * - 6 core tools: memory_search, memory_add, memory_get, memory_list,
 *   memory_update, memory_delete
 * - Short-term (session-scoped) and long-term (user-scoped) memory
 * - Auto-recall: injects relevant memories (both scopes) before each agent turn
 * - Auto-capture: stores key facts scoped to the current session after each agent turn
 * - Per-agent isolation: multi-agent setups write/read from separate userId namespaces
 *   automatically via sessionKey routing (zero breaking changes for single-agent setups)
 * - CLI: openclaw mem0 search, openclaw mem0 status
 * - Dual mode: platform or open-source (self-hosted)
 */

declare const memoryPlugin: {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
};

export { type FileConfig, agentUserId, createProvider, memoryPlugin as default, effectiveUserId, extractAgentId, filterMessagesForExtraction, isGenericAssistantMessage, isNoiseMessage, isNonInteractiveTrigger, isSubagentSession, mem0ConfigSchema, resolveUserId, stripNoiseFromContent };
