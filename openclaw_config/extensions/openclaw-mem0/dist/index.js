import {
  bootstrapTelemetryFlag,
  exists,
  mkdirp,
  readText,
  unlink,
  writeText
} from "./chunk-H3N55OII.js";

// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// providers.ts
function normalizeMemoryItem(raw) {
  return {
    id: raw.id ?? raw.memory_id ?? "",
    memory: raw.memory ?? raw.text ?? raw.content ?? "",
    // Handle both platform (user_id, created_at) and OSS (userId, createdAt) field names
    user_id: raw.user_id ?? raw.userId,
    score: raw.score,
    categories: raw.categories,
    metadata: raw.metadata,
    created_at: raw.created_at ?? raw.createdAt,
    updated_at: raw.updated_at ?? raw.updatedAt
  };
}
function normalizeSearchResults(raw) {
  if (Array.isArray(raw)) return raw.map(normalizeMemoryItem);
  if (raw?.results && Array.isArray(raw.results))
    return raw.results.map(normalizeMemoryItem);
  return [];
}
function normalizeAddResult(raw) {
  if (raw?.results && Array.isArray(raw.results)) {
    return {
      results: raw.results.map((r) => ({
        id: r.id ?? r.memory_id ?? "",
        memory: r.memory ?? r.text ?? "",
        // Platform API may return PENDING status (async processing)
        // OSS stores event in metadata.event
        event: r.event ?? r.metadata?.event ?? (r.status === "PENDING" ? "ADD" : "ADD")
      }))
    };
  }
  if (Array.isArray(raw)) {
    return {
      results: raw.map((r) => ({
        id: r.id ?? r.memory_id ?? "",
        memory: r.memory ?? r.text ?? "",
        event: r.event ?? r.metadata?.event ?? (r.status === "PENDING" ? "ADD" : "ADD")
      }))
    };
  }
  return { results: [] };
}
var PlatformProvider = class {
  constructor(apiKey, baseUrl) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
  client;
  // MemoryClient from mem0ai
  initPromise = null;
  async ensureClient() {
    if (this.client) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }
  async _init() {
    const { default: MemoryClient } = await import("mem0ai");
    const opts = {
      apiKey: this.apiKey
    };
    if (this.baseUrl) opts.host = this.baseUrl;
    this.client = new MemoryClient(opts);
  }
  async add(messages, options) {
    await this.ensureClient();
    const opts = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.custom_instructions)
      opts.custom_instructions = options.custom_instructions;
    if (options.custom_categories)
      opts.custom_categories = options.custom_categories;
    if (options.output_format) opts.output_format = options.output_format;
    if (options.source) opts.source = options.source;
    if (options.infer !== void 0) opts.infer = options.infer;
    if (options.deduced_memories)
      opts.deduced_memories = options.deduced_memories;
    if (options.metadata) opts.metadata = options.metadata;
    if (options.expiration_date) opts.expiration_date = options.expiration_date;
    if (options.immutable) opts.immutable = options.immutable;
    const result = await this.client.add(messages, opts);
    return normalizeAddResult(result);
  }
  async search(query, options) {
    await this.ensureClient();
    const opts = {
      api_version: "v2",
      user_id: options.user_id
    };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.top_k != null) opts.top_k = options.top_k;
    if (options.threshold != null) opts.threshold = options.threshold;
    if (options.keyword_search != null)
      opts.keyword_search = options.keyword_search;
    if (options.reranking != null) opts.rerank = options.reranking;
    if (options.filter_memories != null)
      opts.filter_memories = options.filter_memories;
    if (options.categories != null) opts.categories = options.categories;
    const baseFilters = { user_id: options.user_id };
    if (options.run_id) baseFilters.run_id = options.run_id;
    if (options.filters) {
      opts.filters = { AND: [baseFilters, options.filters] };
    } else {
      opts.filters = baseFilters;
    }
    const results = await this.client.search(query, opts);
    return normalizeSearchResults(results);
  }
  async get(memoryId) {
    await this.ensureClient();
    const result = await this.client.get(memoryId);
    return normalizeMemoryItem(result);
  }
  async getAll(options) {
    await this.ensureClient();
    const opts = {
      api_version: "v2",
      user_id: options.user_id,
      filters: { user_id: options.user_id }
    };
    if (options.run_id) {
      opts.run_id = options.run_id;
      opts.filters.run_id = options.run_id;
    }
    if (options.page_size != null) opts.page_size = options.page_size;
    const results = await this.client.getAll(opts);
    if (Array.isArray(results)) return results.map(normalizeMemoryItem);
    if (results?.results && Array.isArray(results.results))
      return results.results.map(normalizeMemoryItem);
    return [];
  }
  async update(memoryId, text) {
    await this.ensureClient();
    await this.client.update(memoryId, { text });
  }
  async delete(memoryId) {
    await this.ensureClient();
    await this.client.delete(memoryId);
  }
  async deleteAll(userId) {
    await this.ensureClient();
    await this.client.deleteAll({ user_id: userId });
  }
  async history(memoryId) {
    await this.ensureClient();
    const result = await this.client.history(memoryId);
    return Array.isArray(result) ? result : [];
  }
};
var OSSProvider = class {
  constructor(ossConfig, customPrompt, resolvePath) {
    this.ossConfig = ossConfig;
    this.customPrompt = customPrompt;
    this.resolvePath = resolvePath;
  }
  memory;
  // Memory from mem0ai/oss
  initPromise = null;
  async ensureMemory() {
    if (this.memory) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }
  _buildConfig(disableHistory = false) {
    const config = { version: "v1.1" };
    const defaultEmbedder = {
      provider: "openai",
      config: { model: "text-embedding-3-small" }
    };
    const defaultLlm = { provider: "openai", config: { model: "gpt-5.4" } };
    const stripEmpty = (obj) => {
      const out = { ...obj };
      for (const k of Object.keys(out)) {
        if (out[k] === "") delete out[k];
      }
      return out;
    };
    if (this.ossConfig?.embedder) {
      const ec = stripEmpty(this.ossConfig.embedder.config ?? {});
      if (ec.host && !ec.url) {
        ec.url = ec.host;
        delete ec.host;
      }
      config.embedder = {
        provider: this.ossConfig.embedder.provider || defaultEmbedder.provider,
        config: { ...defaultEmbedder.config, ...ec }
      };
    } else {
      config.embedder = defaultEmbedder;
    }
    if (this.ossConfig?.llm) {
      const lc = stripEmpty(this.ossConfig.llm.config ?? {});
      if (lc.host && !lc.url) {
        lc.url = lc.host;
        delete lc.host;
      }
      config.llm = {
        provider: this.ossConfig.llm.provider || defaultLlm.provider,
        config: { ...defaultLlm.config, ...lc }
      };
    } else {
      config.llm = defaultLlm;
    }
    if (this.ossConfig?.vectorStore)
      config.vectorStore = { ...this.ossConfig.vectorStore };
    if (this.ossConfig?.historyDbPath) {
      const dbPath = this.resolvePath ? this.resolvePath(this.ossConfig.historyDbPath) : this.ossConfig.historyDbPath;
      config.historyDbPath = dbPath;
    }
    if (disableHistory || this.ossConfig?.disableHistory) {
      config.disableHistory = true;
    }
    if (this.customPrompt) config.customPrompt = this.customPrompt;
    return config;
  }
  async _init() {
    const mod = await import("mem0ai/oss");
    const Memory = mod.Memory;
    for (const cls of ["PGVector", "RedisDB", "Qdrant"]) {
      const VectorCls = mod[cls];
      if (!VectorCls || VectorCls.prototype.__patched) continue;
      const origInit = VectorCls.prototype.initialize;
      VectorCls.prototype.initialize = function() {
        if (!this.config?.embeddingModelDims && this.config?.dimension) {
          this.config.embeddingModelDims = this.config.dimension;
        }
        if (!this.dimension && this.config?.dimension) {
          this.dimension = this.config.dimension;
        }
        const dims = this.config?.embeddingModelDims ?? this.dimension;
        if (!dims) return Promise.resolve();
        if (!this._initializePromise) {
          this._initializePromise = origInit.call(this);
        }
        return this._initializePromise;
      };
      VectorCls.prototype.__patched = true;
    }
    let mem;
    try {
      mem = new Memory(this._buildConfig());
    } catch (err) {
      if (!this.ossConfig?.disableHistory) {
        console.warn(
          "[mem0] Memory initialization failed, retrying with history disabled:",
          err instanceof Error ? err.message : err
        );
        mem = new Memory(this._buildConfig(true));
      } else {
        throw err;
      }
    }
    await mem.getAll({ userId: "__mem0_warmup__" });
    this.memory = mem;
  }
  async add(messages, options) {
    await this.ensureMemory();
    const addOpts = { userId: options.user_id };
    if (options.run_id) addOpts.runId = options.run_id;
    if (options.source) addOpts.source = options.source;
    if (options.infer !== void 0) addOpts.infer = options.infer;
    if (options.metadata) addOpts.metadata = options.metadata;
    if (options.expiration_date)
      addOpts.expirationDate = options.expiration_date;
    if (options.immutable) addOpts.immutable = options.immutable;
    let effectiveMessages = messages;
    if (options.infer === false && options.deduced_memories?.length) {
      effectiveMessages = options.deduced_memories.map((fact) => ({
        role: "user",
        content: fact
      }));
    }
    const result = await this.memory.add(effectiveMessages, addOpts);
    return normalizeAddResult(result);
  }
  async search(query, options) {
    await this.ensureMemory();
    const opts = { userId: options.user_id };
    if (options.run_id) opts.runId = options.run_id;
    if (options.limit != null) opts.limit = options.limit;
    else if (options.top_k != null) opts.limit = options.top_k;
    if (options.keyword_search != null)
      opts.keyword_search = options.keyword_search;
    if (options.reranking != null) opts.reranking = options.reranking;
    if (options.source) opts.source = options.source;
    if (options.threshold != null) opts.threshold = options.threshold;
    const results = await this.memory.search(query, opts);
    const normalized = normalizeSearchResults(results);
    if (options.threshold != null) {
      return normalized.filter(
        (item) => (item.score ?? 0) >= options.threshold
      );
    }
    return normalized;
  }
  async get(memoryId) {
    await this.ensureMemory();
    const result = await this.memory.get(memoryId);
    return normalizeMemoryItem(result);
  }
  async getAll(options) {
    await this.ensureMemory();
    const getAllOpts = { userId: options.user_id };
    if (options.run_id) getAllOpts.runId = options.run_id;
    if (options.source) getAllOpts.source = options.source;
    const results = await this.memory.getAll(getAllOpts);
    if (Array.isArray(results)) return results.map(normalizeMemoryItem);
    if (results?.results && Array.isArray(results.results))
      return results.results.map(normalizeMemoryItem);
    return [];
  }
  async update(memoryId, text) {
    await this.ensureMemory();
    await this.memory.update(memoryId, text);
  }
  async delete(memoryId) {
    await this.ensureMemory();
    await this.memory.delete(memoryId);
  }
  async deleteAll(userId) {
    await this.ensureMemory();
    await this.memory.deleteAll({ userId });
  }
  async history(memoryId) {
    await this.ensureMemory();
    try {
      const result = await this.memory.history(memoryId);
      return Array.isArray(result) ? result : [];
    } catch (err) {
      console.warn(
        "[mem0] OSS history() failed:",
        err instanceof Error ? err.message : err
      );
      return [];
    }
  }
};
function createProvider(cfg, api) {
  if (cfg.mode === "open-source") {
    return new OSSProvider(
      cfg.oss,
      cfg.customPrompt,
      (p) => api.resolvePath(p)
    );
  }
  return new PlatformProvider(cfg.apiKey, cfg.baseUrl);
}
function providerToBackend(provider, userId) {
  return {
    async add(content, messages, opts = {}) {
      const msgs = messages ?? (content ? [{ role: "user", content }] : []);
      const result = await provider.add(
        msgs,
        {
          user_id: opts.userId ?? userId,
          source: "OPENCLAW",
          ...opts.runId && { run_id: opts.runId },
          ...opts.metadata && { metadata: opts.metadata },
          ...opts.immutable && { immutable: true },
          ...opts.infer === false && { infer: false },
          ...opts.expires && { expiration_date: opts.expires }
        }
      );
      return result;
    },
    async search(query, opts = {}) {
      const results = await provider.search(query, {
        user_id: opts.userId ?? userId,
        top_k: opts.topK,
        threshold: opts.threshold,
        keyword_search: opts.keyword,
        reranking: opts.rerank,
        filters: opts.filters,
        source: "OPENCLAW"
      });
      return results;
    },
    async get(memoryId) {
      const item = await provider.get(memoryId);
      return item;
    },
    async listMemories(opts = {}) {
      const items = await provider.getAll({
        user_id: opts.userId ?? userId,
        page_size: opts.pageSize,
        source: "OPENCLAW"
      });
      return items;
    },
    async update(memoryId, content, metadata) {
      if (content) await provider.update(memoryId, content);
      if (metadata) {
        console.warn(
          "providerToBackend: metadata updates are not supported in OSS mode, only text updates are applied"
        );
      }
      return { id: memoryId, updated: true };
    },
    async delete(memoryId, opts = {}) {
      if (opts.all) {
        await provider.deleteAll(opts.userId ?? userId);
        return { deleted: "all" };
      }
      if (memoryId) {
        await provider.delete(memoryId);
        return { deleted: memoryId };
      }
      throw new Error("Either memoryId or all is required");
    },
    async deleteEntities() {
      throw new Error("Entity management is only available in platform mode.");
    },
    async status() {
      return { connected: true, backend: "oss" };
    },
    async entities() {
      throw new Error("Entity management is only available in platform mode.");
    },
    async listEvents() {
      throw new Error("Event management is only available in platform mode.");
    },
    async getEvent() {
      throw new Error("Event management is only available in platform mode.");
    }
  };
}

// config.ts
import { userInfo } from "os";
var DEFAULT_CUSTOM_INSTRUCTIONS = `Your Task: Extract durable, actionable facts from conversations between a user and an AI assistant. Only store information that would be useful to an agent in a FUTURE session, days or weeks later.

Before storing any fact, ask: "Would a new agent \u2014 with no prior context \u2014 benefit from knowing this?" If the answer is no, do not store it.

Information to Extract (in priority order):

1. Configuration & System State Changes:
   - Tools/services configured, installed, or removed (with versions/dates)
   - Model assignments for agents, API keys configured (NEVER the key itself \u2014 see Exclude)
   - Cron schedules, automation pipelines, deployment configurations
   - Architecture decisions (agent hierarchy, system design, deployment strategy)
   - Specific identifiers: file paths, sheet IDs, channel IDs, user IDs, folder IDs

2. Standing Rules & Policies:
   - Explicit user directives about behavior ("never create accounts without consent")
   - Workflow policies ("each agent must review model selection before completing a task")
   - Security constraints, permission boundaries, access patterns

3. Identity & Demographics:
   - Name, location, timezone, language preferences
   - Occupation, employer, job role, industry

4. Preferences & Opinions:
   - Communication style preferences
   - Tool and technology preferences (with specifics: versions, configs)
   - Strong opinions or values explicitly stated
   - The WHY behind preferences when stated

5. Goals, Projects & Milestones:
   - Active projects (name, description, current status)
   - Completed setup milestones ("ElevenLabs fully configured as of 2026-02-20")
   - Deadlines, roadmaps, and progress tracking
   - Problems actively being solved

6. Technical Context:
   - Tech stack, tools, development environment
   - Agent ecosystem structure (names, roles, relationships)
   - Skill levels in different areas

7. Relationships & People:
   - Names and roles of people mentioned (colleagues, family, clients)
   - Team structure, key contacts

8. Decisions & Lessons:
   - Important decisions made and their reasoning
   - Lessons learned, strategies that worked or failed

Guidelines:

TEMPORAL ANCHORING (critical):
- ALWAYS include temporal context for time-sensitive facts using "As of YYYY-MM-DD, ..."
- Extract dates from message timestamps, dates mentioned in the text, or the system-provided current date
- If no date is available, note "date unknown" rather than omitting temporal context
- Examples: "As of 2026-02-20, ElevenLabs setup is complete" NOT "ElevenLabs setup is complete"

CONCISENESS:
- Use third person ("User prefers..." not "I prefer...")
- Keep related facts together in a single memory to preserve context
- "User's Tailscale machine 'mac' (IP 100.71.135.41) is configured under beau@rizedigital.io (as of 2026-02-20)"
- NOT a paragraph retelling the whole conversation

OUTCOMES OVER INTENT:
- When an assistant message summarizes completed work, extract the durable OUTCOMES
- "Call scripts sheet (ID: 146Qbb...) was updated with truth-based templates" NOT "User wants to update call scripts"
- Extract what WAS DONE, not what was requested

DEDUPLICATION:
- Before creating a new memory, check if a substantially similar fact already exists
- If so, UPDATE the existing memory with any new details rather than creating a duplicate

LANGUAGE:
- ALWAYS preserve the original language of the conversation
- If the user speaks Spanish, store the memory in Spanish; do not translate

Exclude (NEVER store):
- Passwords, API keys, tokens, secrets, or any credentials \u2014 even when embedded in configuration blocks, setup logs, or tool output. This includes strings starting with sk-, m0-, ak_, ghp_, bot tokens (digits followed by colon and alphanumeric string), bearer tokens, webhook URLs containing tokens, pairing codes, and any long alphanumeric strings that appear in config/env contexts. Never include the actual secret value in a memory. Instead, record that the credential was configured:
  WRONG: "User's API key is sk-abc123..." or "Bot token is 12345:AABcd..."
  RIGHT: "API key was configured for the service (as of YYYY-MM-DD)" or "Telegram bot token was set up"
- One-time commands or instructions ("stop the script", "continue where you left off")
- Acknowledgments or emotional reactions ("ok", "sounds good", "you're right", "sir")
- Transient UI/navigation states ("user is in the admin panel", "relay is attached")
- Ephemeral process status ("download at 50%", "daemon not running", "still syncing")
- Cron heartbeat outputs, NO_REPLY responses, compaction flush directives
- The current date/time as a standalone fact \u2014 timestamps are conversation context, not durable knowledge. "User indicates current time is 3:25 PM" is NEVER worth storing. However, DO use timestamps to anchor other facts: "User installed Ollama on 2026-03-21" is correct.
- System routing metadata (message IDs, sender IDs, channel routing info)
- Generic small talk with no informational content
- Raw code snippets (capture the intent/decision, not the code itself)
- Information the user explicitly asks not to remember`;
var DEFAULT_CUSTOM_CATEGORIES = {
  identity: "Personal identity information: name, age, location, timezone, occupation, employer, education, demographics",
  preferences: "Explicitly stated likes, dislikes, preferences, opinions, and values across any domain",
  goals: "Current and future goals, aspirations, objectives, targets the user is working toward",
  projects: "Specific projects, initiatives, or endeavors the user is working on, including status and details",
  technical: "Technical skills, tools, tech stack, development environment, programming languages, frameworks",
  decisions: "Important decisions made, reasoning behind choices, strategy changes, and their outcomes",
  relationships: "People mentioned by the user: colleagues, family, friends, their roles and relevance",
  routines: "Daily habits, work patterns, schedules, productivity routines, health and wellness habits",
  life_events: "Significant life events, milestones, transitions, upcoming plans and changes",
  lessons: "Lessons learned, insights gained, mistakes acknowledged, changed opinions or beliefs",
  work: "Work-related context: job responsibilities, workplace dynamics, career progression, professional challenges",
  health: "Health-related information voluntarily shared: conditions, medications, fitness, wellness goals"
};
var ALLOWED_KEYS = [
  "mode",
  "apiKey",
  "baseUrl",
  "userId",
  "userEmail",
  "autoCapture",
  "autoRecall",
  "customInstructions",
  "customCategories",
  "customPrompt",
  "searchThreshold",
  "topK",
  "oss",
  "skills"
];
function assertAllowedKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}
var mem0ConfigSchema = {
  parse(value, fileConfig) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("openclaw-mem0 config required");
    }
    const cfg = value;
    assertAllowedKeys(cfg, ALLOWED_KEYS, "openclaw-mem0 config");
    if (typeof cfg.mode === "string" && cfg.mode !== "platform" && cfg.mode !== "open-source") {
      console.warn(
        `[mem0] Unknown mode "${cfg.mode}" \u2014 expected "platform" or "open-source". Defaulting to "platform".`
      );
    }
    const mode = cfg.mode === "open-source" ? "open-source" : "platform";
    let resolvedApiKey = typeof cfg.apiKey === "string" ? cfg.apiKey : void 0;
    let resolvedBaseUrl = typeof cfg.baseUrl === "string" ? cfg.baseUrl : void 0;
    if (mode === "platform" && !resolvedApiKey && fileConfig) {
      if (fileConfig.apiKey) resolvedApiKey = fileConfig.apiKey;
      if (fileConfig.baseUrl) resolvedBaseUrl = fileConfig.baseUrl;
    }
    const needsSetup = mode === "platform" && !resolvedApiKey;
    let ossConfig;
    if (cfg.oss && typeof cfg.oss === "object" && !Array.isArray(cfg.oss)) {
      ossConfig = cfg.oss;
    }
    return {
      mode,
      apiKey: resolvedApiKey,
      baseUrl: resolvedBaseUrl,
      userId: typeof cfg.userId === "string" && cfg.userId ? cfg.userId : (() => {
        try {
          return userInfo().username || "default";
        } catch {
          return "default";
        }
      })(),
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      customInstructions: typeof cfg.customInstructions === "string" ? cfg.customInstructions : DEFAULT_CUSTOM_INSTRUCTIONS,
      customCategories: cfg.customCategories && typeof cfg.customCategories === "object" && !Array.isArray(cfg.customCategories) ? cfg.customCategories : DEFAULT_CUSTOM_CATEGORIES,
      customPrompt: typeof cfg.customPrompt === "string" ? cfg.customPrompt : DEFAULT_CUSTOM_INSTRUCTIONS,
      searchThreshold: typeof cfg.searchThreshold === "number" ? cfg.searchThreshold : 0.5,
      topK: typeof cfg.topK === "number" ? cfg.topK : 5,
      needsSetup,
      oss: ossConfig,
      skills: cfg.skills && typeof cfg.skills === "object" && !Array.isArray(cfg.skills) ? cfg.skills : void 0
    };
  }
};

// filtering.ts
var NOISE_MESSAGE_PATTERNS = [
  /^(HEARTBEAT_OK|NO_REPLY)$/i,
  /^Current time:.*\d{4}/,
  /^Pre-compaction memory flush/i,
  /^(ok|yes|no|sir|sure|thanks|done|good|nice|cool|got it|it's on|continue)$/i,
  /^System: \[.*\] (Slack message edited|Gateway restart|Exec (failed|completed))/,
  /^System: \[.*\] ⚠️ Post-Compaction Audit:/
];
var NOISE_CONTENT_PATTERNS = [
  {
    pattern: /Conversation info \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```/g,
    replacement: ""
  },
  {
    // OpenClaw TUI sends "Sender (untrusted metadata)" with a JSON block
    // containing label, id, name, username — strip to prevent storing as memory
    pattern: /Sender\s*\(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi,
    replacement: ""
  },
  { pattern: /\[media attached:.*?\]/g, replacement: "" },
  {
    pattern: /To send an image back, prefer the message tool[\s\S]*?Keep caption in the text body\./g,
    replacement: ""
  },
  {
    pattern: /System: \[\d{4}-\d{2}-\d{2}.*?\] ⚠️ Post-Compaction Audit:[\s\S]*?after memory compaction\./g,
    replacement: ""
  },
  {
    pattern: /Replied message \(untrusted, for context\):\s*```json[\s\S]*?```/g,
    replacement: ""
  },
  /* JARVIS_THINK_PATCH */
  { pattern: /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, replacement: "" }
];
var MAX_MESSAGE_LENGTH = 2e3;
var GENERIC_ASSISTANT_PATTERNS = [
  /^(I see you'?ve shared|Thanks for sharing|Got it[.!]?\s*(I see|Let me|How can)|I understand[.!]?\s*(How can|Is there|Would you))/i,
  /^(How can I help|Is there anything|Would you like me to|Let me know (if|how|what))/i,
  /^(I('?ll| will) (help|assist|look into|review|take a look))/i,
  /^(Sure[.!]?\s*(How|What|Is)|Understood[.!]?\s*(How|What|Is))/i,
  /^(That('?s| is) (noted|understood|clear))/i
];
function isNoiseMessage(content) {
  const trimmed = content.trim();
  if (!trimmed) return true;
  return NOISE_MESSAGE_PATTERNS.some((p) => p.test(trimmed));
}
function isGenericAssistantMessage(content) {
  const trimmed = content.trim();
  if (trimmed.length > 300) return false;
  return GENERIC_ASSISTANT_PATTERNS.some((p) => p.test(trimmed));
}
function stripNoiseFromContent(content) {
  let cleaned = content;
  for (const { pattern, replacement } of NOISE_CONTENT_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}
function truncateMessage(content) {
  if (content.length <= MAX_MESSAGE_LENGTH) return content;
  return content.slice(0, MAX_MESSAGE_LENGTH) + "\n[...truncated]";
}
function filterMessagesForExtraction(messages) {
  const filtered = [];
  for (const msg of messages) {
    if (isNoiseMessage(msg.content)) continue;
    if (msg.role === "assistant" && isGenericAssistantMessage(msg.content))
      continue;
    const cleaned = stripNoiseFromContent(msg.content);
    if (!cleaned) continue;
    filtered.push({ role: msg.role, content: truncateMessage(cleaned) });
  }
  return filtered;
}

// isolation.ts
var SKIP_TRIGGERS = /* @__PURE__ */ new Set(["cron", "heartbeat", "automation", "schedule"]);
function isNonInteractiveTrigger(trigger, sessionKey) {
  if (trigger && SKIP_TRIGGERS.has(trigger.toLowerCase())) return true;
  if (sessionKey) {
    if (/:cron:/i.test(sessionKey) || /:heartbeat:/i.test(sessionKey))
      return true;
  }
  return false;
}
function isSubagentSession(sessionKey) {
  if (!sessionKey) return false;
  return /:subagent:/i.test(sessionKey);
}
function extractAgentId(sessionKey) {
  if (!sessionKey) return void 0;
  const subagentMatch = sessionKey.match(/:subagent:([^:]+)$/);
  if (subagentMatch?.[1]) return `subagent-${subagentMatch[1]}`;
  const match = sessionKey.match(/^agent:([^:]+):/);
  const agentId = match?.[1];
  if (!agentId || agentId === "main") return void 0;
  return agentId;
}
function effectiveUserId(baseUserId, sessionKey) {
  const agentId = extractAgentId(sessionKey);
  return agentId ? `${baseUserId}:agent:${agentId}` : baseUserId;
}
function agentUserId(baseUserId, agentId) {
  return `${baseUserId}:agent:${agentId}`;
}
function resolveUserId(baseUserId, opts, currentSessionId) {
  if (opts.agentId) return agentUserId(baseUserId, opts.agentId);
  if (opts.userId) return opts.userId;
  return effectiveUserId(baseUserId, currentSessionId);
}

// skill-loader.ts
import * as path from "path";
import { fileURLToPath } from "url";
var DEFAULT_CATEGORIES = {
  configuration: { importance: 0.95, ttl: null },
  rule: { importance: 0.9, ttl: null },
  identity: { importance: 0.95, ttl: null, immutable: true },
  preference: { importance: 0.85, ttl: null },
  decision: { importance: 0.8, ttl: null },
  technical: { importance: 0.8, ttl: null },
  relationship: { importance: 0.75, ttl: null },
  project: { importance: 0.75, ttl: "90d" },
  operational: { importance: 0.6, ttl: "7d" }
};
var DEFAULT_CREDENTIAL_PATTERNS = [
  "sk-",
  "m0-",
  "ghp_",
  "AKIA",
  "ak_",
  "Bearer ",
  "bot\\d+:AA",
  "password=",
  "token=",
  "secret="
];
function parseSkillFile(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    return {
      frontmatter: { name: "unknown" },
      body: content
    };
  }
  const fmBlock = fmMatch[1];
  const body = fmMatch[2].trim();
  const fm = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (value === "false") value = false;
    else if (value === "true") value = true;
    fm[key] = value;
  }
  return {
    frontmatter: fm,
    body
  };
}
function resolveSkillsDir() {
  const candidates = [];
  try {
    const metaDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(metaDir, "skills"));
    candidates.push(path.join(metaDir, "..", "skills"));
  } catch {
  }
  if (typeof __dirname !== "undefined") {
    candidates.push(path.join(__dirname, "skills"));
    candidates.push(path.join(__dirname, "..", "skills"));
  }
  for (const dir of candidates) {
    if (exists(path.join(dir, "memory-triage", "SKILL.md"))) {
      return dir;
    }
  }
  return candidates[0] ?? "skills";
}
var SKILLS_DIR = resolveSkillsDir();
var RESOLVED_SKILLS_DIR = path.resolve(SKILLS_DIR);
function safePath(...segments) {
  const resolved = path.resolve(SKILLS_DIR, ...segments);
  if (resolved !== RESOLVED_SKILLS_DIR && !resolved.startsWith(RESOLVED_SKILLS_DIR + path.sep)) {
    return null;
  }
  return resolved;
}
function readSkillFile(skillName) {
  const filePath = safePath(skillName, "SKILL.md");
  if (!filePath) return null;
  try {
    return readText(filePath);
  } catch {
    return null;
  }
}
function readDomainOverlay(domain, targetSkill) {
  const filePath = safePath(targetSkill, "domains", `${domain}.md`);
  if (!filePath) return null;
  try {
    const content = readText(filePath);
    const parsed = parseSkillFile(content);
    const appliesTo = parsed.frontmatter.applies_to;
    if (appliesTo && appliesTo !== targetSkill) {
      return null;
    }
    return parsed.body;
  } catch {
    return null;
  }
}
function renderCategoriesBlock(categories) {
  const lines = [
    "\n## Active Category Configuration (overrides defaults above)\n"
  ];
  for (const [name, cat] of Object.entries(categories)) {
    const ttlLabel = cat.ttl ? `expires: ${cat.ttl}` : "permanent";
    const immLabel = cat.immutable ? ", immutable" : "";
    lines.push(
      `- **${name.toUpperCase()}** (importance: ${cat.importance} | ${ttlLabel}${immLabel})`
    );
  }
  return lines.join("\n");
}
function renderTriageKnobs(config) {
  const triage = config.triage;
  if (!triage) return "";
  const lines = [];
  if (triage.importanceThreshold !== void 0) {
    lines.push(
      `- Only store facts with importance >= ${triage.importanceThreshold}`
    );
  }
  const patterns = resolveCredentialPatterns(config);
  if (config.triage?.credentialPatterns) {
    lines.push(`- Credential patterns to scan: ${patterns.join(", ")}`);
  }
  if (lines.length === 0) return "";
  return "\n## Active Configuration Overrides\n\n" + lines.join("\n");
}
function ttlToExpirationDate(ttl) {
  if (!ttl) return null;
  const match = ttl.match(/^(\d+)d$/);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  const date = /* @__PURE__ */ new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().split("T")[0];
}
function loadSkill(skillName, config = {}) {
  const raw = readSkillFile(skillName);
  if (!raw) return null;
  const parsed = parseSkillFile(raw);
  const parts = [parsed.body];
  if (config.domain) {
    const overlay = readDomainOverlay(config.domain, skillName);
    if (overlay) {
      parts.push("\n" + overlay);
    }
  }
  if (skillName === "memory-triage" && config.categories) {
    const mergedCats = resolveCategories(config);
    parts.push(renderCategoriesBlock(mergedCats));
  }
  if (skillName === "memory-triage") {
    const knobs = renderTriageKnobs(config);
    if (knobs) parts.push(knobs);
  }
  if (skillName === "memory-triage" && config.customRules) {
    const rulesBlock = ["\n## User Custom Rules\n"];
    if (config.customRules.include?.length) {
      rulesBlock.push("Additionally extract:");
      for (const rule of config.customRules.include) {
        rulesBlock.push(`- ${rule}`);
      }
    }
    if (config.customRules.exclude?.length) {
      rulesBlock.push("\nAdditionally skip:");
      for (const rule of config.customRules.exclude) {
        rulesBlock.push(`- ${rule}`);
      }
    }
    parts.push(rulesBlock.join("\n"));
  }
  return {
    name: skillName,
    prompt: parts.join("\n"),
    frontmatter: parsed.frontmatter
  };
}
function loadTriagePrompt(config = {}) {
  const triage = loadSkill("memory-triage", config);
  if (triage) {
    const parts2 = [];
    parts2.push("<memory-system>");
    parts2.push(
      "IMPORTANT: Use `memory_add` tool for ALL user facts. NEVER write user info to workspace files (USER.md, memory/)."
    );
    parts2.push("");
    parts2.push(triage.prompt);
    parts2.push("");
    parts2.push("## Tool Usage");
    parts2.push("");
    parts2.push(
      "Batch facts by CATEGORY. All facts in one memory_add call must share the same category because category determines retention policy (TTL, immutability). If a turn has facts in different categories, make one call per category."
    );
    parts2.push("");
    parts2.push("FORMAT (single category):");
    parts2.push(
      '  memory_add(facts: ["User is Alex, backend engineer at Stripe, PST timezone"], category: "identity")'
    );
    parts2.push("FORMAT (mixed categories in one turn, separate calls):");
    parts2.push(
      '  memory_add(facts: ["User is Alex, backend engineer at Stripe, PST timezone"], category: "identity")'
    );
    parts2.push(
      '  memory_add(facts: ["As of 2026-04-01, migrating from Postgres to CockroachDB"], category: "decision")'
    );
    if (config.recall?.enabled !== false) {
      const strategy = config.recall?.strategy ?? "smart";
      parts2.push("");
      parts2.push("## Searching Memory");
      parts2.push("");
      if (strategy === "manual") {
        parts2.push(
          "You control all memory search. No automatic recall happens. Use memory_search proactively:"
        );
        parts2.push(
          "- At the start of a new conversation, search for user identity and context."
        );
        parts2.push(
          "- When the user references something you do not have context for."
        );
        parts2.push("- When the conversation topic shifts to a new domain.");
        parts2.push(
          "- Before updating a memory, search to find the existing version."
        );
        parts2.push("");
      }
      parts2.push(
        "When calling memory_search, ALWAYS rewrite the query. NEVER pass the user's raw message."
      );
      parts2.push(
        "Stored memories are third-person factual statements. Write a query that matches storage language, not conversation language."
      );
      parts2.push(
        "Process: (1) Name your target. (2) Extract signal: proper nouns, technical terms, domain concepts. (3) Bridge to storage language: add terms the stored memory contains (user, decided, prefers, rule, configured, based in). (4) Compose 3-6 keywords."
      );
      parts2.push(
        'WRONG: memory_search("Who was that nutritionist my wife recommended?")'
      );
      parts2.push(
        'RIGHT: memory_search("nutritionist wife recommended relationship")'
      );
      parts2.push('WRONG: memory_search("What timezone am I in?")');
      parts2.push('RIGHT: memory_search("user timezone location based")');
      parts2.push("");
      parts2.push(
        "ENTITY SCOPING: Memories are scoped by user_id, agent_id, and run_id. You do not need to pass these in most cases. The plugin handles scoping automatically based on the current session."
      );
      parts2.push(
        "- Default behavior: all memory operations use the configured userId and current session. You do not need to pass userId or agentId."
      );
      parts2.push(
        "- Use agentId only when you need to read or write memories for a DIFFERENT agent (e.g., querying what the 'researcher' agent knows). This accesses a separate namespace."
      );
      parts2.push(
        "- Use userId only when explicitly instructed to operate on a different user's memories."
      );
      parts2.push(
        "- Do not pass run_id directly. The plugin manages session scoping through the scope parameter."
      );
      parts2.push(
        "- In multi-agent setups, each agent has isolated memory. The main agent's memories are separate from subagent memories."
      );
      parts2.push("");
      parts2.push("SEARCH SCOPE: Choose the right scope for each search:");
      parts2.push(
        '- scope: "long-term" for user context, identity, preferences, decisions (default, most common)'
      );
      parts2.push('- scope: "session" for facts from this conversation only');
      parts2.push(
        '- scope: "all" only when you truly need both scopes combined'
      );
      parts2.push("Using a specific scope avoids unnecessary backend fan-out.");
      parts2.push("");
      parts2.push(
        "SEARCH FILTERS: When the user's intent implies a time range or category constraint, pass a `filters` object alongside your rewritten query."
      );
      parts2.push(
        '- Time: "last week" -> filters: {"created_at": {"gte": "2026-03-24"}}'
      );
      parts2.push('- Category: "my preferences" -> categories: ["preference"]');
      parts2.push(
        "- Available operators: eq, ne, gt, gte, lt, lte, in, contains. Logical: AND, OR, NOT."
      );
    }
    parts2.push("</memory-system>");
    return parts2.join("\n");
  }
  const parts = [];
  parts.push("<memory-system>");
  parts.push(
    "You have persistent long-term memory via mem0. After EVERY response, evaluate the turn for facts worth storing."
  );
  parts.push(
    "Use `memory_add` tool for ALL user facts. NEVER write user info to workspace files (USER.md, memory/)."
  );
  parts.push("Most turns produce ZERO memory operations. That is correct.");
  parts.push(
    "Only store facts a new agent would need days later: identity, preferences, decisions, rules, projects, configs."
  );
  parts.push(
    "Batch facts by CATEGORY. All facts in one call must share the same category."
  );
  parts.push(
    'Format: memory_add(facts: ["fact text"], category: "identity")'
  );
  parts.push(
    "NEVER store credentials (sk-, m0-, ghp_, AKIA, Bearer tokens, passwords)."
  );
  if (config.recall?.enabled !== false) {
    parts.push(
      "When searching, rewrite queries for retrieval. Do not pass raw user messages."
    );
  }
  parts.push("</memory-system>");
  return parts.join("\n");
}
function loadDreamPrompt(config = {}) {
  const dream = loadSkill("memory-dream", config);
  if (!dream) return "";
  return dream.prompt;
}
function resolveCategories(config = {}) {
  return { ...DEFAULT_CATEGORIES, ...config.categories || {} };
}
function resolveCredentialPatterns(config = {}) {
  return config.triage?.credentialPatterns ?? DEFAULT_CREDENTIAL_PATTERNS;
}
function isSkillsMode(config) {
  if (!config) return false;
  return config.triage?.enabled !== false;
}

// recall.ts
var DEFAULT_TOKEN_BUDGET = 1500;
var DEFAULT_MAX_MEMORIES = 15;
var DEFAULT_THRESHOLD = 0.4;
var DEFAULT_CATEGORY_ORDER = [
  "identity",
  "configuration",
  "rule",
  "preference",
  "decision",
  "technical",
  "relationship",
  "project",
  "operational"
];
var CHARS_PER_TOKEN = 4;
function getMemoryCategory(memory) {
  if (memory.metadata?.category && typeof memory.metadata.category === "string") {
    return memory.metadata.category;
  }
  if (memory.categories?.length) {
    return memory.categories[0];
  }
  return "uncategorized";
}
function getMemoryImportance(memory) {
  if (memory.metadata?.importance && typeof memory.metadata.importance === "number") {
    return memory.metadata.importance;
  }
  const cat = getMemoryCategory(memory);
  const defaults = {
    identity: 0.95,
    configuration: 0.95,
    rule: 0.9,
    preference: 0.85,
    decision: 0.8,
    technical: 0.8,
    relationship: 0.75,
    project: 0.75,
    operational: 0.6
  };
  return defaults[cat] ?? 0.5;
}
function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
function rankMemories(memories, categoryOrder) {
  const orderMap = new Map(categoryOrder.map((cat, i) => [cat, i]));
  return [...memories].sort((a, b) => {
    const catA = getMemoryCategory(a);
    const catB = getMemoryCategory(b);
    const orderA = orderMap.get(catA) ?? 999;
    const orderB = orderMap.get(catB) ?? 999;
    if (orderA !== orderB) return orderA - orderB;
    const impA = getMemoryImportance(a);
    const impB = getMemoryImportance(b);
    if (impA !== impB) return impB - impA;
    return (b.score ?? 0) - (a.score ?? 0);
  });
}
function budgetMemories(rankedMemories, tokenBudget, maxMemories, identityAlwaysInclude) {
  const selected = [];
  let usedTokens = 0;
  for (const memory of rankedMemories) {
    if (selected.length >= maxMemories) break;
    const memTokens = estimateTokens(memory.memory);
    const isIdentity = getMemoryCategory(memory) === "identity" || getMemoryCategory(memory) === "configuration";
    if (identityAlwaysInclude && isIdentity) {
      selected.push(memory);
      usedTokens += memTokens;
      continue;
    }
    if (usedTokens + memTokens > tokenBudget) continue;
    selected.push(memory);
    usedTokens += memTokens;
  }
  return selected;
}
function formatRecalledMemories(memories, userId) {
  if (memories.length === 0) {
    return `<recalled-memories>
No stored memories found for "${userId}".
</recalled-memories>`;
  }
  const grouped = /* @__PURE__ */ new Map();
  for (const mem of memories) {
    const cat = getMemoryCategory(mem);
    const existing = grouped.get(cat) || [];
    existing.push(mem);
    grouped.set(cat, existing);
  }
  const lines = [
    `<recalled-memories>`,
    `Stored memories for "${userId}" (${memories.length} total, ranked by importance):`,
    ""
  ];
  for (const [category, mems] of grouped.entries()) {
    const label = category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`${label}:`);
    for (const mem of mems) {
      const imp = getMemoryImportance(mem);
      const cats = mem.categories?.length ? ` [${mem.categories.join(", ")}]` : "";
      lines.push(`- ${mem.memory}${cats} (${Math.round(imp * 100)}%)`);
    }
    lines.push("");
  }
  lines.push("</recalled-memories>");
  return lines.join("\n");
}
function sanitizeQuery(raw) {
  let cleaned = raw.replace(
    /Sender\s*\(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi,
    ""
  );
  cleaned = cleaned.replace(/^\[.*?\]\s*/g, "");
  cleaned = cleaned.trim();
  return cleaned || raw;
}
async function recall(provider, query, userId, config = {}, sessionId) {
  const recallConfig = config.recall ?? {};
  const tokenBudget = recallConfig.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const maxMemories = recallConfig.maxMemories ?? DEFAULT_MAX_MEMORIES;
  const threshold = recallConfig.threshold ?? DEFAULT_THRESHOLD;
  const categoryOrder = recallConfig.categoryOrder ?? DEFAULT_CATEGORY_ORDER;
  const identityAlwaysInclude = recallConfig.identityAlwaysInclude !== false;
  const searchOpts = {
    user_id: userId,
    top_k: maxMemories * 2,
    // Over-fetch for ranking
    threshold,
    keyword_search: recallConfig.keywordSearch !== false,
    // Default on
    reranking: recallConfig.rerank !== false,
    // Default on
    source: "OPENCLAW"
  };
  if (recallConfig.filterMemories) {
    searchOpts.filter_memories = true;
  }
  const cleanQuery = sanitizeQuery(query);
  let longTermMemories = [];
  try {
    longTermMemories = await provider.search(cleanQuery, searchOpts);
  } catch (err) {
    console.warn(
      "[mem0] Recall search failed:",
      err instanceof Error ? err.message : err
    );
  }
  let sessionMemories = [];
  if (sessionId) {
    try {
      sessionMemories = await provider.search(cleanQuery, {
        ...searchOpts,
        run_id: sessionId,
        top_k: 5
      });
    } catch {
    }
  }
  const longTermIds = new Set(longTermMemories.map((m) => m.id));
  const uniqueSession = sessionMemories.filter((m) => !longTermIds.has(m.id));
  const allMemories = [...longTermMemories, ...uniqueSession];
  const ranked = rankMemories(allMemories, categoryOrder);
  const budgeted = budgetMemories(
    ranked,
    tokenBudget,
    maxMemories,
    identityAlwaysInclude
  );
  const context = formatRecalledMemories(budgeted, userId);
  const tokenEstimate = estimateTokens(context);
  return { context, memories: budgeted, tokenEstimate };
}

// dream-gate.ts
import * as path2 from "path";
var DEFAULTS = {
  minHours: 24,
  minSessions: 5,
  minMemories: 20
};
var LOCK_STALE_MS = 60 * 60 * 1e3;
function statePath(stateDir) {
  return path2.join(stateDir, "dream-state.json");
}
function lockPath(stateDir) {
  return path2.join(stateDir, "dream.lock");
}
function ensureDir(dir) {
  try {
    mkdirp(dir);
  } catch {
  }
}
function readState(stateDir) {
  try {
    const raw = readText(statePath(stateDir));
    return JSON.parse(raw);
  } catch {
    return { lastConsolidatedAt: 0, sessionsSince: 0, lastSessionId: null };
  }
}
function writeState(stateDir, state) {
  ensureDir(stateDir);
  writeText(statePath(stateDir), JSON.stringify(state, null, 2));
}
function incrementSessionCount(stateDir, sessionId) {
  const state = readState(stateDir);
  if (state.lastSessionId !== sessionId) {
    state.sessionsSince++;
    state.lastSessionId = sessionId;
    writeState(stateDir, state);
  }
}
function checkCheapGates(stateDir, config) {
  const minHours = config.minHours ?? DEFAULTS.minHours;
  const minSessions = config.minSessions ?? DEFAULTS.minSessions;
  const state = readState(stateDir);
  const hoursSince = (Date.now() - state.lastConsolidatedAt) / 36e5;
  if (hoursSince < minHours) {
    return {
      proceed: false,
      reason: `time: ${hoursSince.toFixed(1)}h < ${minHours}h`
    };
  }
  if (state.sessionsSince < minSessions) {
    return {
      proceed: false,
      reason: `sessions: ${state.sessionsSince} < ${minSessions}`
    };
  }
  return { proceed: true };
}
function checkMemoryGate(memoryCount, config) {
  const minMemories = config.minMemories ?? DEFAULTS.minMemories;
  if (memoryCount < minMemories) {
    return { pass: false, reason: `memories: ${memoryCount} < ${minMemories}` };
  }
  return { pass: true };
}
function acquireDreamLock(stateDir) {
  ensureDir(stateDir);
  const lp = lockPath(stateDir);
  try {
    const raw = readText(lp);
    const lock2 = JSON.parse(raw);
    const age = Date.now() - lock2.startedAt;
    if (age < LOCK_STALE_MS) {
      return false;
    }
    try {
      unlink(lp);
    } catch {
    }
  } catch {
  }
  const lock = { pid: process.pid, startedAt: Date.now() };
  try {
    writeText(lp, JSON.stringify(lock), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function releaseDreamLock(stateDir) {
  try {
    unlink(lockPath(stateDir));
  } catch {
  }
}
function recordDreamCompletion(stateDir) {
  const state = readState(stateDir);
  state.lastConsolidatedAt = Date.now();
  state.sessionsSince = 0;
  state.lastSessionId = null;
  writeState(stateDir, state);
}

// telemetry.ts
import { createHash, randomUUID } from "crypto";

// cli/config-file.ts
import { join as join3 } from "path";
import { homedir } from "os";
var OPENCLAW_CONFIG_DIR = join3(homedir(), ".openclaw");
var OPENCLAW_CONFIG_FILE = join3(OPENCLAW_CONFIG_DIR, "openclaw.json");
var DEFAULT_BASE_URL = "https://api.mem0.ai";
var PLUGIN_ID = "openclaw-mem0";
function readFullConfig() {
  if (exists(OPENCLAW_CONFIG_FILE)) {
    try {
      return JSON.parse(readText(OPENCLAW_CONFIG_FILE));
    } catch {
    }
  }
  return {};
}
function writeFullConfig(config) {
  if (!exists(OPENCLAW_CONFIG_DIR)) {
    mkdirp(OPENCLAW_CONFIG_DIR, 448);
  }
  writeText(
    OPENCLAW_CONFIG_FILE,
    JSON.stringify(config, null, 2),
    { mode: 384 }
  );
}
function readPluginAuth() {
  const full = readFullConfig();
  const cfg = full?.plugins?.entries?.[PLUGIN_ID]?.config;
  if (!cfg || typeof cfg !== "object") return {};
  return {
    apiKey: cfg.apiKey ?? cfg.api_key,
    baseUrl: cfg.baseUrl ?? cfg.base_url,
    userId: cfg.userId ?? cfg.user_id,
    userEmail: cfg.userEmail ?? cfg.user_email,
    mode: cfg.mode,
    autoRecall: cfg.autoRecall,
    autoCapture: cfg.autoCapture,
    topK: cfg.topK,
    anonymousTelemetryId: cfg.anonymousTelemetryId
  };
}
function writePluginAuth(auth) {
  const full = readFullConfig();
  if (!full.plugins) full.plugins = {};
  if (!full.plugins.entries) full.plugins.entries = {};
  if (!full.plugins.entries[PLUGIN_ID]) {
    full.plugins.entries[PLUGIN_ID] = { enabled: true, config: {} };
  }
  if (!full.plugins.entries[PLUGIN_ID].config) {
    full.plugins.entries[PLUGIN_ID].config = {};
  }
  const cfg = full.plugins.entries[PLUGIN_ID].config;
  for (const [key, value] of Object.entries(auth)) {
    if (value !== void 0) cfg[key] = value;
  }
  writeFullConfig(full);
}
function writePluginConfigField(path3, value) {
  const full = readFullConfig();
  if (!full.plugins) full.plugins = {};
  if (!full.plugins.entries) full.plugins.entries = {};
  if (!full.plugins.entries[PLUGIN_ID]) {
    full.plugins.entries[PLUGIN_ID] = { enabled: true, config: {} };
  }
  if (!full.plugins.entries[PLUGIN_ID].config) {
    full.plugins.entries[PLUGIN_ID].config = {};
  }
  let target = full.plugins.entries[PLUGIN_ID].config;
  for (let i = 0; i < path3.length - 1; i++) {
    if (!target[path3[i]] || typeof target[path3[i]] !== "object") {
      target[path3[i]] = {};
    }
    target = target[path3[i]];
  }
  target[path3[path3.length - 1]] = value;
  writeFullConfig(full);
}
function getBaseUrl() {
  const auth = readPluginAuth();
  return auth.baseUrl || DEFAULT_BASE_URL;
}

// telemetry.ts
var PLUGIN_VERSION = "1.0.6";
var POSTHOG_API_KEY = "phc_hgJkUVJFYtmaJqrvf6CYN67TIQ8yhXAkWzUn9AMU4yX";
var POSTHOG_HOST = "https://us.i.posthog.com/i/v0/e/";
var FLUSH_INTERVAL_MS = 5e3;
var FLUSH_THRESHOLD = 10;
var eventQueue = [];
var flushTimer;
var _cachedAnonymousId;
var _aliasCheckDone = false;
function getOrCreateAnonymousId() {
  if (_cachedAnonymousId) return _cachedAnonymousId;
  try {
    const auth = readPluginAuth();
    if (auth.anonymousTelemetryId) {
      _cachedAnonymousId = auth.anonymousTelemetryId;
      return _cachedAnonymousId;
    }
  } catch {
  }
  const newId = `openclaw-anon-${randomUUID().replace(/-/g, "")}`;
  try {
    writePluginAuth({ anonymousTelemetryId: newId });
  } catch {
  }
  _cachedAnonymousId = newId;
  return newId;
}
function maybeBuildIdentifyEvent(distinctId) {
  if (_aliasCheckDone) return null;
  if (!distinctId || distinctId.startsWith("openclaw-anon-")) return null;
  try {
    const auth = readPluginAuth();
    const storedAnon = auth.anonymousTelemetryId;
    if (!storedAnon) {
      _aliasCheckDone = true;
      return null;
    }
    const identifyEvent = {
      event: "$identify",
      distinct_id: distinctId,
      properties: {
        $anon_distinct_id: storedAnon,
        $lib: "posthog-node"
      }
    };
    try {
      writePluginAuth({ anonymousTelemetryId: "" });
    } catch {
    }
    _aliasCheckDone = true;
    _cachedAnonymousId = void 0;
    return identifyEvent;
  } catch {
    return null;
  }
}
var _emailResolutionAttempted = false;
function maybeResolveEmail(apiKey) {
  if (_emailResolutionAttempted) return;
  _emailResolutionAttempted = true;
  const baseUrl = getBaseUrl().replace(/\/+$/, "");
  fetch(`${baseUrl}/v1/ping/`, {
    method: "GET",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(5e3)
  }).then((res) => res.json()).then((data) => {
    const email = data?.user_email;
    if (email) {
      try {
        writePluginAuth({ userEmail: email });
      } catch {
      }
      const oldId = createHash("md5").update(apiKey).digest("hex");
      for (const ev of eventQueue) {
        if (ev.distinct_id === oldId) {
          ev.distinct_id = email;
        }
        if (ev.event === "$identify" && ev.distinct_id === oldId) {
          ev.distinct_id = email;
        }
      }
    }
  }).catch(() => {
  });
}
var _telemetryEnabled;
function isTelemetryEnabled() {
  if (_telemetryEnabled !== void 0) return _telemetryEnabled;
  try {
    const val = globalThis.__mem0_telemetry_override;
    if (val !== void 0) {
      const s = String(val).toLowerCase();
      _telemetryEnabled = s !== "false" && s !== "0" && s !== "no";
    } else {
      _telemetryEnabled = true;
    }
  } catch {
    _telemetryEnabled = true;
  }
  return _telemetryEnabled;
}
function getDistinctId(apiKey) {
  try {
    const auth = readPluginAuth();
    if (auth.userEmail) return auth.userEmail;
  } catch {
  }
  if (apiKey) {
    return createHash("md5").update(apiKey).digest("hex");
  }
  return getOrCreateAnonymousId();
}
function ensureFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(flushEvents, FLUSH_INTERVAL_MS);
  if (typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}
var _exitHandlerInstalled = false;
function ensureExitHandler() {
  if (_exitHandlerInstalled) return;
  _exitHandlerInstalled = true;
  process.on("beforeExit", async () => {
    if (eventQueue.length === 0) return;
    const batch = eventQueue;
    eventQueue = [];
    const body = JSON.stringify({ api_key: POSTHOG_API_KEY, batch });
    try {
      await fetch(POSTHOG_HOST, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body))
        },
        body,
        signal: AbortSignal.timeout(3e3)
      });
    } catch {
    }
  });
}
function flushEvents() {
  if (eventQueue.length === 0) return;
  const batch = eventQueue;
  eventQueue = [];
  const body = JSON.stringify({ api_key: POSTHOG_API_KEY, batch });
  fetch(POSTHOG_HOST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body))
    },
    body,
    signal: AbortSignal.timeout(3e3)
  }).catch(() => {
  });
}
function captureEvent(eventName, properties = {}, ctx) {
  if (!isTelemetryEnabled()) return;
  try {
    const distinctId = getDistinctId(ctx?.apiKey);
    if (ctx?.apiKey && distinctId && !distinctId.includes("@") && !distinctId.startsWith("openclaw-anon-")) {
      maybeResolveEmail(ctx.apiKey);
    }
    const identifyEvent = maybeBuildIdentifyEvent(distinctId);
    if (identifyEvent) {
      eventQueue.push(identifyEvent);
    }
    eventQueue.push({
      event: eventName,
      distinct_id: distinctId,
      properties: {
        source: "OPENCLAW",
        language: "node",
        plugin_version: PLUGIN_VERSION,
        node_version: process.version,
        os: process.platform,
        mode: ctx?.mode,
        skills_active: ctx?.skillsActive,
        $process_person_profile: false,
        $lib: "posthog-node",
        ...properties
      }
    });
    ensureFlushTimer();
    ensureExitHandler();
    if (eventQueue.length >= FLUSH_THRESHOLD) {
      flushEvents();
    }
  } catch {
  }
}

// backend/base.ts
var AuthError = class extends Error {
  constructor(message = "Authentication failed. Your API key may be invalid or expired.") {
    super(message);
    this.name = "AuthError";
  }
};
var NotFoundError = class extends Error {
  constructor(path3) {
    super(`Resource not found: ${path3}`);
    this.name = "NotFoundError";
  }
};
var APIError = class extends Error {
  constructor(path3, detail) {
    super(`Bad request to ${path3}: ${detail}`);
    this.name = "APIError";
  }
};

// backend/platform.ts
var PlatformBackend = class {
  baseUrl;
  headers;
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.headers = {
      Authorization: `Token ${config.apiKey}`,
      "Content-Type": "application/json",
      "X-Mem0-Source": "OPENCLAW",
      "X-Mem0-Client-Language": "node",
      "X-Mem0-Client-Version": PLUGIN_VERSION,
      "X-Mem0-Caller-Type": "plugin"
    };
  }
  async _request(method, path3, opts) {
    let url = `${this.baseUrl}${path3}`;
    if (opts?.params) {
      const qs = new URLSearchParams(opts.params).toString();
      url += `?${qs}`;
    }
    const fetchOpts = {
      method,
      headers: this.headers,
      signal: AbortSignal.timeout(3e4)
    };
    if (opts?.json) {
      fetchOpts.body = JSON.stringify(opts.json);
    }
    const resp = await fetch(url, fetchOpts);
    if (resp.status === 401) {
      throw new AuthError();
    }
    if (resp.status === 404) {
      throw new NotFoundError(path3);
    }
    if (resp.status === 400) {
      let detail;
      try {
        const body = await resp.json();
        detail = body.detail ?? body.message ?? JSON.stringify(body) ?? resp.statusText;
      } catch {
        detail = resp.statusText;
      }
      throw new APIError(path3, detail);
    }
    if (!resp.ok) {
      let detail = resp.statusText;
      try {
        const body = await resp.json();
        detail = body.detail ?? body.message ?? resp.statusText;
      } catch {
      }
      throw new Error(`HTTP ${resp.status}: ${detail}`);
    }
    if (resp.status === 204) {
      return {};
    }
    return resp.json();
  }
  async add(content, messages, opts = {}) {
    const payload = {};
    if (messages) {
      payload.messages = messages;
    } else if (content) {
      payload.messages = [{ role: "user", content }];
    }
    if (opts.userId) payload.user_id = opts.userId;
    if (opts.agentId) payload.agent_id = opts.agentId;
    if (opts.appId) payload.app_id = opts.appId;
    if (opts.runId) payload.run_id = opts.runId;
    if (opts.metadata) payload.metadata = opts.metadata;
    if (opts.immutable) payload.immutable = true;
    if (opts.infer === false) payload.infer = false;
    if (opts.expires) payload.expiration_date = opts.expires;
    if (opts.categories) payload.categories = opts.categories;
    return await this._request("POST", "/v1/memories/", {
      json: payload
    });
  }
  _buildFilters(opts) {
    if (opts.extraFilters && ("AND" in opts.extraFilters || "OR" in opts.extraFilters)) {
      return opts.extraFilters;
    }
    const andConditions = [];
    if (opts.userId) andConditions.push({ user_id: opts.userId });
    if (opts.agentId) andConditions.push({ agent_id: opts.agentId });
    if (opts.appId) andConditions.push({ app_id: opts.appId });
    if (opts.runId) andConditions.push({ run_id: opts.runId });
    if (opts.extraFilters) {
      for (const [k, v] of Object.entries(opts.extraFilters)) {
        andConditions.push({ [k]: v });
      }
    }
    if (andConditions.length === 1) return andConditions[0];
    if (andConditions.length > 1) return { AND: andConditions };
    return void 0;
  }
  async search(query, opts = {}) {
    const payload = {
      query,
      top_k: opts.topK ?? 10,
      threshold: opts.threshold ?? 0.3
    };
    const apiFilters = this._buildFilters({
      userId: opts.userId,
      agentId: opts.agentId,
      appId: opts.appId,
      runId: opts.runId,
      extraFilters: opts.filters
    });
    if (apiFilters) payload.filters = apiFilters;
    if (opts.rerank) payload.rerank = true;
    if (opts.keyword) payload.keyword_search = true;
    if (opts.fields) payload.fields = opts.fields;
    const result = await this._request("POST", "/v2/memories/search/", {
      json: payload
    });
    if (Array.isArray(result)) return result;
    const obj = result;
    return obj.results ?? obj.memories ?? [];
  }
  async get(memoryId) {
    return await this._request("GET", `/v1/memories/${memoryId}/`);
  }
  async listMemories(opts = {}) {
    const payload = {};
    const params = {
      page: String(opts.page ?? 1),
      page_size: String(opts.pageSize ?? 100)
    };
    const extra = {};
    if (opts.category) {
      extra.categories = { contains: opts.category };
    }
    if (opts.after) {
      extra.created_at = {
        ...extra.created_at,
        gte: opts.after
      };
    }
    if (opts.before) {
      extra.created_at = {
        ...extra.created_at,
        lte: opts.before
      };
    }
    const apiFilters = this._buildFilters({
      userId: opts.userId,
      agentId: opts.agentId,
      appId: opts.appId,
      runId: opts.runId,
      extraFilters: Object.keys(extra).length > 0 ? extra : void 0
    });
    if (apiFilters) payload.filters = apiFilters;
    const result = await this._request("POST", "/v2/memories/", {
      json: payload,
      params
    });
    if (Array.isArray(result)) return result;
    const obj = result;
    return obj.results ?? obj.memories ?? [];
  }
  async update(memoryId, content, metadata) {
    const payload = {};
    if (content) payload.text = content;
    if (metadata) payload.metadata = metadata;
    return await this._request("PUT", `/v1/memories/${memoryId}/`, {
      json: payload
    });
  }
  async delete(memoryId, opts = {}) {
    if (opts.all) {
      const params = {};
      if (opts.userId) params.user_id = opts.userId;
      if (opts.agentId) params.agent_id = opts.agentId;
      if (opts.appId) params.app_id = opts.appId;
      if (opts.runId) params.run_id = opts.runId;
      return await this._request("DELETE", "/v1/memories/", {
        params
      });
    }
    if (memoryId) {
      return await this._request(
        "DELETE",
        `/v1/memories/${memoryId}/`
      );
    }
    throw new Error("Either memoryId or --all is required");
  }
  async deleteEntities(opts) {
    const typeMap = [
      ["user", opts.userId],
      ["agent", opts.agentId],
      ["app", opts.appId],
      ["run", opts.runId]
    ];
    const entities = typeMap.filter(([, v]) => v);
    if (entities.length === 0) {
      throw new Error("At least one entity ID is required for deleteEntities.");
    }
    let result = {};
    for (const [entityType, entityId] of entities) {
      result = await this._request(
        "DELETE",
        `/v2/entities/${entityType}/${entityId}/`
      );
    }
    return result;
  }
  async ping() {
    return await this._request("GET", "/v1/ping/");
  }
  async status(_opts = {}) {
    try {
      await this.ping();
      return { connected: true, backend: "platform", base_url: this.baseUrl };
    } catch (e) {
      return {
        connected: false,
        backend: "platform",
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }
  async entities(entityType) {
    const result = await this._request("GET", "/v1/entities/");
    let items;
    if (Array.isArray(result)) {
      items = result;
    } else {
      items = result.results ?? [];
    }
    const typeMap = {
      users: "user",
      agents: "agent",
      apps: "app",
      runs: "run"
    };
    const targetType = typeMap[entityType];
    if (targetType) {
      items = items.filter(
        (e) => e.type?.toLowerCase() === targetType
      );
    }
    return items;
  }
  async listEvents() {
    const result = await this._request("GET", "/v1/events/");
    if (Array.isArray(result)) return result;
    return result.results ?? [];
  }
  async getEvent(eventId) {
    return await this._request("GET", `/v1/event/${eventId}/`);
  }
};

// cli/commands.ts
import { createInterface } from "readline";
import { userInfo as osUserInfo } from "os";
function promptInput(question, prefill) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve2) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve2(answer.trim());
    });
    if (prefill) rl.write(prefill);
  });
}
function getSystemUsername() {
  try {
    return osUserInfo().username || "default";
  } catch {
    return "default";
  }
}
function resolveUserId2(flagValue, existingValue) {
  if (flagValue) return flagValue;
  if (existingValue) return existingValue;
  return getSystemUsername();
}
async function apiPost(url, body, errorPrefix) {
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mem0-Source": "OPENCLAW",
        "X-Mem0-Client-Language": "node"
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error(`Could not reach ${url}: ${String(err)}`);
    return null;
  }
  if (resp.status === 429) {
    console.error("Too many attempts. Try again in a few minutes.");
    return null;
  }
  if (!resp.ok) {
    let detail;
    try {
      const data = await resp.json();
      detail = String(data.error ?? resp.statusText);
    } catch {
      detail = resp.statusText;
    }
    console.error(`${errorPrefix}: ${detail}`);
    return null;
  }
  try {
    return await resp.json();
  } catch {
    return {};
  }
}
async function validateApiKey(baseUrl, apiKey) {
  try {
    const resp = await fetch(`${baseUrl}/v1/ping/`, {
      headers: {
        Authorization: `Token ${apiKey}`,
        "X-Mem0-Source": "OPENCLAW",
        "X-Mem0-Client-Language": "node"
      }
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    try {
      const data = await resp.json();
      return { ok: true, userEmail: data.user_email };
    } catch {
      return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
async function sendVerificationCode(baseUrl, email) {
  const url = baseUrl.replace(/\/+$/, "");
  const result = await apiPost(
    `${url}/api/v1/auth/email_code/`,
    { email },
    "Failed to send code"
  );
  return result !== null;
}
async function verifyEmailCode(baseUrl, email, code) {
  const url = baseUrl.replace(/\/+$/, "");
  const result = await apiPost(
    `${url}/api/v1/auth/email_code/verify/`,
    { email, code: code.trim() },
    "Verification failed"
  );
  if (!result) return null;
  const apiKey = result.api_key;
  if (!apiKey) {
    console.error(
      "Auth succeeded but no API key was returned. Contact support."
    );
    return null;
  }
  return apiKey;
}
function saveLoginConfig(apiKey, userIdFlag, userEmail) {
  const existingAuth = readPluginAuth();
  const userId = resolveUserId2(userIdFlag, existingAuth.userId);
  writePluginAuth({ apiKey, userId, mode: "platform", ...userEmail && { userEmail } });
  console.log(`  Configuration saved to ${OPENCLAW_CONFIG_FILE}`);
  console.log(`  Mode: platform`);
  console.log(`  User ID: ${userId}`);
}
function saveOssConfig(userIdFlag) {
  const existingAuth = readPluginAuth();
  const userId = resolveUserId2(userIdFlag, existingAuth.userId);
  writePluginAuth({ userId, mode: "open-source" });
  console.log(`  Configuration saved to ${OPENCLAW_CONFIG_FILE}`);
  console.log(`  Mode: open-source`);
  console.log(`  User ID: ${userId}`);
}
function registerCliCommands(api, backend, provider, cfg, effectiveUserId2, agentUserId2, buildSearchOptions, getCurrentSessionId, captureCliEvent) {
  api.registerCli(
    ({ program }) => {
      const mem0 = program.command("mem0").description("Mem0 memory plugin commands").configureHelp({ sortSubcommands: false, subcommandTerm: (cmd) => cmd.name() });
      if (captureCliEvent) {
        mem0.hook("preAction", (_thisCmd, actionCmd) => {
          try {
            const name = actionCmd.name();
            const parent = actionCmd.parent?.name();
            const full = parent && parent !== "mem0" ? `${parent}.${name}` : name;
            captureCliEvent(full);
          } catch {
          }
        });
      }
      mem0.command("init").description("Set up Mem0 \u2014 authenticate and configure").option("--email <email>", "Login via email verification code").option("--code <code>", "Verification code (use with --email)").option("--api-key <key>", "Direct API key entry").option("--user-id <id>", "Set user ID for memory namespace").action(
        async (opts) => {
          try {
            const baseUrl = "https://api.mem0.ai";
            const existingAuth = readPluginAuth();
            const hasExistingConfig = !!(existingAuth.apiKey || existingAuth.mode);
            if (opts.apiKey) {
              if (opts.email) {
                console.error("Cannot use both --api-key and --email.");
                return;
              }
              const check = await validateApiKey(baseUrl, opts.apiKey);
              saveLoginConfig(opts.apiKey, opts.userId, check.userEmail);
              if (hasExistingConfig) {
                console.log(
                  "  Existing configuration detected \u2014 updated API key (other settings preserved)."
                );
              }
              if (check.ok) {
                console.log(
                  "  API key validated. Connected to Mem0 Platform."
                );
              } else if (check.status) {
                console.warn(
                  `  API key saved but validation returned HTTP ${check.status}. Check that the key is correct.`
                );
              } else {
                console.warn(
                  `  API key saved but could not reach ${baseUrl}: ${check.error}. Check your network connection.`
                );
              }
              console.log(
                "  Restart the gateway: openclaw gateway restart\n"
              );
              return;
            }
            if (opts.email && opts.code) {
              const email = opts.email.trim().toLowerCase();
              const apiKey = await verifyEmailCode(baseUrl, email, opts.code);
              if (!apiKey) return;
              saveLoginConfig(apiKey, opts.userId, email);
              if (hasExistingConfig) {
                console.log(
                  "  Existing configuration detected \u2014 updated API key (other settings preserved)."
                );
              }
              console.log("  Authenticated!");
              console.log(
                "  Restart the gateway: openclaw gateway restart\n"
              );
              return;
            }
            if (opts.email) {
              const email = opts.email.trim().toLowerCase();
              const sent = await sendVerificationCode(baseUrl, email);
              if (sent) {
                console.log(
                  `Verification code sent! Run:
  openclaw mem0 init --email ${email} --code <CODE>`
                );
              }
              return;
            }
            if (!process.stdin.isTTY) {
              console.log("Usage (non-interactive):");
              console.log(
                "  openclaw mem0 init --api-key <key>"
              );
              console.log(
                "  openclaw mem0 init --api-key <key> --user-id <id>"
              );
              console.log(
                "  openclaw mem0 init --email <email>"
              );
              console.log(
                "  openclaw mem0 init --email <email> --code <c>"
              );
              console.log(
                "  openclaw mem0 init --email <email> --code <c> --user-id <id>"
              );
              return;
            }
            if (hasExistingConfig) {
              console.log("\n  Existing Mem0 configuration found:\n");
              if (existingAuth.apiKey) {
                const masked = existingAuth.apiKey.length > 8 ? existingAuth.apiKey.slice(0, 4) + "..." + existingAuth.apiKey.slice(-4) : existingAuth.apiKey.slice(0, 2) + "***";
                console.log(`    API Key:  ${masked}`);
              }
              if (existingAuth.userId)
                console.log(`    User ID:  ${existingAuth.userId}`);
              if (existingAuth.mode)
                console.log(`    Mode:     ${existingAuth.mode}`);
              console.log("");
              if (existingAuth.apiKey) {
                const check = await validateApiKey(
                  baseUrl,
                  existingAuth.apiKey
                );
                if (check.ok) {
                  console.log(
                    "    Existing API key is valid and connected.\n"
                  );
                } else {
                  console.log(
                    "    Existing API key could not be validated (may be expired or revoked).\n"
                  );
                }
              }
              const reuse = await promptInput(
                "  Keep existing configuration? (y/n): "
              );
              if (reuse === "" || reuse.toLowerCase() === "y" || reuse.toLowerCase() === "yes") {
                console.log(
                  "\n  Configuration preserved. No changes made."
                );
                console.log(
                  "  To update individual settings: openclaw mem0 config set <key> <value>\n"
                );
                return;
              }
              console.log("");
            }
            console.log("\n  Mem0 Setup\n");
            console.log("  How would you like to set up Mem0?");
            console.log("  1. Login with email (recommended)");
            console.log("  2. Enter API key manually");
            console.log("  3. Open-source mode (self-hosted)\n");
            const choice = await promptInput("  Choice (1/2/3): ") || "1";
            if (choice === "1") {
              const email = (await promptInput("  Email: ")).toLowerCase();
              if (!email) {
                console.error("Email is required.");
                return;
              }
              const sent = await sendVerificationCode(baseUrl, email);
              if (!sent) return;
              console.log(
                "  Verification code sent! Check your email.\n"
              );
              const code = await promptInput("  Code: ");
              if (!code) {
                console.error("Code is required.");
                return;
              }
              const apiKey = await verifyEmailCode(baseUrl, email, code);
              if (!apiKey) return;
              let userIdValue = opts.userId;
              if (!userIdValue) {
                const defaultUid = resolveUserId2(void 0, existingAuth.userId);
                const uidInput = await promptInput(
                  `  User ID: `,
                  defaultUid
                );
                userIdValue = uidInput || defaultUid;
              }
              console.log("");
              saveLoginConfig(apiKey, userIdValue, email);
              console.log("  Authenticated!");
              console.log(
                "  Restart the gateway: openclaw gateway restart\n"
              );
            } else if (choice === "2") {
              const key = await promptInput("  API Key: ");
              if (!key) {
                console.error("API key is required.");
                return;
              }
              let userIdValue2 = opts.userId;
              if (!userIdValue2) {
                const defaultUid = resolveUserId2(void 0, existingAuth.userId);
                const uidInput = await promptInput(
                  `  User ID: `,
                  defaultUid
                );
                userIdValue2 = uidInput || defaultUid;
              }
              console.log("");
              const check = await validateApiKey(baseUrl, key);
              saveLoginConfig(key, userIdValue2, check.userEmail);
              if (check.ok) {
                console.log(
                  "  API key validated. Connected to Mem0 Platform."
                );
              } else if (check.status) {
                console.warn(
                  `  API key saved but validation returned HTTP ${check.status}.`
                );
              } else {
                console.warn(
                  `  API key saved but could not reach ${baseUrl}: ${check.error}`
                );
              }
              console.log(
                "  Restart the gateway: openclaw gateway restart\n"
              );
            } else if (choice === "3") {
              console.log(
                "\n  Open-source mode uses the Mem0 OSS SDK locally."
              );
              console.log(
                "  By default it requires an OpenAI API key for embeddings and LLM.\n"
              );
              console.log(
                "  You need an OpenAI API key for embeddings and LLM."
              );
              console.log(
                "  Get one from https://platform.openai.com/api-keys\n"
              );
              const openaiKey = await promptInput(
                "  OpenAI API Key (or press Enter to skip): "
              );
              if (openaiKey) {
                writePluginConfigField(
                  ["oss", "embedder"],
                  { provider: "openai", config: { apiKey: openaiKey } }
                );
                writePluginConfigField(
                  ["oss", "llm"],
                  { provider: "openai", config: { apiKey: openaiKey } }
                );
                console.log(
                  "\n  OpenAI API key saved to config.\n"
                );
              } else {
                console.log(
                  "\n  Skipped. You can add it later via:"
                );
                console.log(
                  "    openclaw mem0 config set embedder_key <key>"
                );
                console.log(
                  "  Or set OPENAI_API_KEY in your environment.\n"
                );
              }
              let userIdValue3 = opts.userId;
              if (!userIdValue3) {
                const defaultUid = resolveUserId2(void 0, existingAuth.userId);
                const uidInput = await promptInput(
                  `  User ID: `,
                  defaultUid
                );
                userIdValue3 = uidInput || defaultUid;
              }
              console.log("");
              saveOssConfig(userIdValue3);
              console.log("  Open-source mode configured!");
              console.log(
                "  Restart the gateway: openclaw gateway restart\n"
              );
            } else {
              console.log(
                "Invalid choice. Run `openclaw mem0 init` again."
              );
            }
          } catch (err) {
            console.error(`Init failed: ${String(err)}`);
          }
        }
      );
      mem0.command("search").description("Search memories").argument("<query>", "Search query").option("--top-k <n>", "Max results", String(cfg.topK)).option(
        "--scope <scope>",
        'Memory scope: "session", "long-term", or "all"',
        "all"
      ).option("--agent-id <agentId>", "Search agent's memory namespace").option("--user-id <userId>", "Override user ID").action(
        async (query, opts) => {
          try {
            const limit = parseInt(opts.topK, 10);
            const scope = opts.scope;
            const currentSessionId = getCurrentSessionId();
            const uid = opts.userId ? opts.userId : opts.agentId ? agentUserId2(opts.agentId) : effectiveUserId2(currentSessionId);
            const cliSearchOpts = (userIdOverride, lim, runId) => {
              const base = buildSearchOptions(userIdOverride, lim, runId);
              base.threshold = 0.3;
              return base;
            };
            let allResults = [];
            if (scope === "session" || scope === "all") {
              if (currentSessionId) {
                const sessionResults = await provider.search(
                  query,
                  cliSearchOpts(uid, limit, currentSessionId)
                );
                if (sessionResults?.length) {
                  allResults.push(
                    ...sessionResults.map((r) => ({
                      ...r,
                      _scope: "session"
                    }))
                  );
                }
              } else if (scope === "session") {
                console.log(
                  "No active session ID available for session-scoped search."
                );
                return;
              }
            }
            if (scope === "long-term" || scope === "all") {
              const longTermResults = await provider.search(
                query,
                cliSearchOpts(uid, limit)
              );
              if (longTermResults?.length) {
                allResults.push(
                  ...longTermResults.map((r) => ({
                    ...r,
                    _scope: "long-term"
                  }))
                );
              }
            }
            if (scope === "all") {
              const seen = /* @__PURE__ */ new Set();
              allResults = allResults.filter((r) => {
                if (seen.has(r.id)) return false;
                seen.add(r.id);
                return true;
              });
            }
            if (!allResults.length) {
              console.log("No memories found.");
              return;
            }
            const output = allResults.map((r) => ({
              id: r.id,
              memory: r.memory,
              score: r.score,
              scope: r._scope,
              categories: r.categories,
              created_at: r.created_at
            }));
            console.log(JSON.stringify(output, null, 2));
          } catch (err) {
            console.error(`Search failed: ${String(err)}`);
          }
        }
      );
      mem0.command("add").description("Add a memory from text").argument("<text>", "Text to store as a memory").option("--user-id <userId>", "Override user ID").option("--agent-id <agentId>", "Store in agent's memory namespace").action(
        async (text, opts) => {
          try {
            const uid = opts.userId ? opts.userId : opts.agentId ? agentUserId2(opts.agentId) : effectiveUserId2(getCurrentSessionId());
            const result = await provider.add(
              [{ role: "user", content: text }],
              { user_id: uid, source: "OPENCLAW" }
            );
            const count = result.results?.length ?? 0;
            if (count > 0) {
              console.log(`Added ${count} memory(s):`);
              for (const r of result.results) {
                console.log(`  ${r.id}: ${r.memory} [${r.event}]`);
              }
            } else {
              console.log(
                "No new memories extracted (text may already be stored or not contain durable facts)."
              );
            }
          } catch (err) {
            console.error(`Add failed: ${String(err)}`);
          }
        }
      );
      mem0.command("get").description("Get a specific memory by ID").argument("<memory_id>", "Memory ID to retrieve").action(async (memoryId) => {
        try {
          const memory = await provider.get(memoryId);
          console.log(
            JSON.stringify(
              {
                id: memory.id,
                memory: memory.memory,
                user_id: memory.user_id,
                categories: memory.categories,
                metadata: memory.metadata,
                created_at: memory.created_at,
                updated_at: memory.updated_at
              },
              null,
              2
            )
          );
        } catch (err) {
          console.error(`Get failed: ${String(err)}`);
        }
      });
      mem0.command("list").description("List memories with optional filters").option("--user-id <userId>", "Override user ID").option("--agent-id <agentId>", "List agent's memories").option("--top-k <n>", "Max results", "50").action(
        async (opts) => {
          try {
            const uid = opts.userId ? opts.userId : opts.agentId ? agentUserId2(opts.agentId) : cfg.userId;
            const limit = parseInt(opts.topK, 10);
            const memories = await provider.getAll({
              user_id: uid,
              page_size: limit,
              source: "OPENCLAW"
            });
            if (!Array.isArray(memories) || memories.length === 0) {
              console.log("No memories found.");
              return;
            }
            const output = memories.map((m) => ({
              id: m.id,
              memory: m.memory,
              categories: m.categories,
              created_at: m.created_at,
              updated_at: m.updated_at
            }));
            console.log(JSON.stringify(output, null, 2));
            console.log(`
Total: ${memories.length} memories`);
          } catch (err) {
            console.error(`List failed: ${String(err)}`);
          }
        }
      );
      mem0.command("update").description("Update a memory's text").argument("<memory_id>", "Memory ID to update").argument("<text>", "New text for the memory").action(async (memoryId, text) => {
        try {
          await provider.update(memoryId, text);
          console.log(`Memory ${memoryId} updated.`);
        } catch (err) {
          console.error(`Update failed: ${String(err)}`);
        }
      });
      mem0.command("delete").description("Delete a memory, or all memories for a user").argument("[memory_id]", "Memory ID to delete").option("--all", "Delete all memories for the user").option("--user-id <userId>", "Override user ID (with --all)").option("--agent-id <agentId>", "Delete from agent's namespace").option("--confirm", "Skip confirmation for bulk delete").action(
        async (memoryId, opts) => {
          try {
            if (opts.all) {
              const uid = opts.userId ? opts.userId : opts.agentId ? agentUserId2(opts.agentId) : cfg.userId;
              if (!opts.confirm && process.stdin.isTTY) {
                const answer = await promptInput(
                  `  Delete ALL memories for user "${uid}"? This cannot be undone. (yes/N): `
                );
                if (answer.toLowerCase() !== "yes") {
                  console.log("Cancelled.");
                  return;
                }
              } else if (!opts.confirm) {
                console.error(
                  "Bulk delete requires --confirm flag in non-interactive mode."
                );
                return;
              }
              await provider.deleteAll(uid);
              console.log(`All memories deleted for user "${uid}".`);
              return;
            }
            if (!memoryId) {
              console.error(
                "Provide a memory_id or use --all to delete all memories."
              );
              return;
            }
            await provider.delete(memoryId);
            console.log(`Memory ${memoryId} deleted.`);
          } catch (err) {
            console.error(`Delete failed: ${String(err)}`);
          }
        }
      );
      mem0.command("status").description("Check API connectivity and current config").action(async () => {
        try {
          const auth = readPluginAuth();
          console.log(`Mode: ${cfg.mode}`);
          console.log(`User ID: ${cfg.userId}`);
          console.log(`Config: ${OPENCLAW_CONFIG_FILE}`);
          console.log("");
          const result = await backend.status();
          if (result.connected) {
            console.log("Connected to Mem0");
          } else {
            console.log("Not connected to Mem0");
          }
          if (result.url) {
            console.log(`URL: ${String(result.url)}`);
          }
          if (result.error) {
            console.log(`Error: ${String(result.error)}`);
          }
        } catch (err) {
          console.error(`Status check failed: ${String(err)}`);
        }
      });
      const configCmd = mem0.command("config").description("Manage plugin configuration");
      const CONFIG_KEYS = {
        // Short aliases (matches Python CLI)
        api_key: "apiKey",
        email: "userEmail",
        base_url: "baseUrl",
        user_id: "userId",
        auto_recall: "autoRecall",
        auto_capture: "autoCapture",
        top_k: "topK",
        mode: "mode",
        embedder_provider: "oss.embedder.provider",
        embedder_model: "oss.embedder.config.model",
        embedder_key: "oss.embedder.config.apiKey",
        llm_provider: "oss.llm.provider",
        llm_model: "oss.llm.config.model",
        llm_key: "oss.llm.config.apiKey",
        vector_provider: "oss.vectorStore.provider",
        vector_host: "oss.vectorStore.config.host",
        vector_port: "oss.vectorStore.config.port",
        collection_name: "oss.vectorStore.config.collectionName",
        vector_db_name: "oss.vectorStore.config.dbname",
        vector_db_user: "oss.vectorStore.config.user",
        vector_db_path: "oss.vectorStore.config.dbPath",
        history_db_path: "oss.historyDbPath",
        disable_history: "oss.disableHistory"
      };
      const SECRET_KEYS = /* @__PURE__ */ new Set(["apiKey", "oss.embedder.config.apiKey", "oss.llm.config.apiKey"]);
      const BOOLEAN_KEYS = /* @__PURE__ */ new Set([
        "autoRecall",
        "autoCapture",
        "oss.disableHistory"
      ]);
      const INTEGER_KEYS = /* @__PURE__ */ new Set(["topK", "oss.vectorStore.config.port"]);
      function resolveConfigKey(key) {
        return CONFIG_KEYS[key] ?? null;
      }
      function getConfigValue(field) {
        if (field.startsWith("oss.")) {
          const parts = field.split(".");
          let current = cfg.oss;
          for (let i = 1; i < parts.length && current != null; i++) {
            current = current[parts[i]];
          }
          return current;
        }
        const auth = readPluginAuth();
        const values = {
          apiKey: auth.apiKey ?? cfg.apiKey,
          baseUrl: auth.baseUrl ?? cfg.baseUrl ?? "https://api.mem0.ai",
          userId: auth.userId ?? cfg.userId,
          mode: auth.mode ?? cfg.mode,
          userEmail: auth.userEmail,
          autoRecall: cfg.autoRecall,
          autoCapture: cfg.autoCapture,
          topK: cfg.topK
        };
        return values[field];
      }
      function redact(value) {
        if (value.length <= 8) return value.slice(0, 2) + "***";
        return value.slice(0, 4) + "..." + value.slice(-4);
      }
      function displayValue(field, value) {
        if (value === void 0 || value === null || value === "") {
          return "(not set)";
        }
        if (SECRET_KEYS.has(field) && typeof value === "string") {
          return redact(value);
        }
        return String(value);
      }
      configCmd.command("show").description("Show current configuration").action(() => {
        const entries = [
          ["mode", "mode"],
          ["user_id", "userId"],
          ["auto_recall", "autoRecall"],
          ["auto_capture", "autoCapture"],
          ["top_k", "topK"]
        ];
        if (cfg.mode === "platform") {
          entries.push(
            ["api_key", "apiKey"],
            ["email", "userEmail"]
          );
        } else {
          entries.push(
            ["embedder_provider", "oss.embedder.provider"],
            ["embedder_model", "oss.embedder.config.model"],
            ["embedder_key", "oss.embedder.config.apiKey"],
            ["llm_provider", "oss.llm.provider"],
            ["llm_model", "oss.llm.config.model"],
            ["llm_key", "oss.llm.config.apiKey"],
            ["vector_provider", "oss.vectorStore.provider"],
            ["history_db_path", "oss.historyDbPath"],
            ["disable_history", "oss.disableHistory"]
          );
        }
        const maxKeyLen = Math.max(
          ...entries.map(([k]) => k.length),
          3
        );
        console.log("");
        console.log(
          `  ${"Key".padEnd(maxKeyLen)}   Value`
        );
        console.log(
          `  ${"\u2500".repeat(maxKeyLen)}   ${"\u2500".repeat(30)}`
        );
        for (const [displayKey, field] of entries) {
          const value = getConfigValue(field);
          const display = displayValue(field, value);
          console.log(
            `  ${displayKey.padEnd(maxKeyLen)}   ${display}`
          );
        }
        console.log("");
        console.log(`  Config file: ${OPENCLAW_CONFIG_FILE}`);
        console.log("");
        console.log("  To change a setting:");
        console.log("    openclaw mem0 config set <key> <value>");
        console.log("");
        console.log("  Examples:");
        if (cfg.mode === "platform") {
          console.log("    openclaw mem0 config set mode open-source");
          console.log("    openclaw mem0 config set auto_recall false");
        } else {
          console.log("    openclaw mem0 config set vector_provider qdrant");
          console.log("    openclaw mem0 config set llm_model gpt-4o");
          console.log("    openclaw mem0 config set embedder_provider openai");
        }
        console.log("");
      });
      configCmd.command("get").description("Get a config value").argument("<key>", "Config key (e.g. user_id, api_key, llm_model)").action((key) => {
        const field = resolveConfigKey(key);
        if (!field) {
          console.error(
            `Unknown config key: ${key}`
          );
          return;
        }
        const value = getConfigValue(field);
        console.log(displayValue(field, value));
      });
      configCmd.command("set").description("Set a config value").argument("<key>", "Config key (e.g. user_id, api_key, llm_model)").argument("<value>", "New value").action((key, rawValue) => {
        const field = resolveConfigKey(key);
        if (!field) {
          console.error(
            `Unknown config key: ${key}`
          );
          return;
        }
        let value = rawValue;
        if (BOOLEAN_KEYS.has(field)) {
          value = rawValue.toLowerCase() === "true" || rawValue === "1" || rawValue.toLowerCase() === "yes";
        } else if (INTEGER_KEYS.has(field)) {
          const parsed = parseInt(rawValue, 10);
          if (isNaN(parsed)) {
            console.error(`Invalid integer value: ${rawValue}`);
            return;
          }
          value = parsed;
        }
        if (field.startsWith("oss.")) {
          writePluginConfigField(field.split("."), value);
        } else {
          writePluginAuth({ [field]: value });
        }
        console.log(
          `${key} = ${displayValue(field, value)}`
        );
      });
      mem0.command("import").description("Import memories from a JSON file").argument("<file>", "Path to JSON file containing memories").option("--user-id <userId>", "Override user ID for all imported memories").option("--agent-id <agentId>", "Override agent ID for all imported memories").action(
        async (file, opts) => {
          try {
            let data;
            try {
              data = JSON.parse(readText(file));
            } catch (err) {
              console.error(`Failed to read file: ${String(err)}`);
              return;
            }
            const items = Array.isArray(data) ? data : [data];
            let added = 0;
            let failed = 0;
            for (const item of items) {
              const content = item?.memory ?? item?.text ?? item?.content ?? "";
              if (!content) {
                failed++;
                continue;
              }
              try {
                await backend.add(content, void 0, {
                  userId: opts.userId ?? item?.user_id ?? cfg.userId,
                  agentId: opts.agentId ?? item?.agent_id,
                  metadata: item?.metadata
                });
                added++;
              } catch {
                failed++;
              }
            }
            console.log(`Imported ${added} memories.`);
            if (failed) {
              console.error(`${failed} memories failed to import.`);
            }
          } catch (err) {
            console.error(`Import failed: ${String(err)}`);
          }
        }
      );
      const eventCmd = mem0.command("event").description("Manage background processing events");
      eventCmd.command("list").description("List recent background events").action(async () => {
        try {
          if (!backend || cfg.mode === "open-source") {
            console.log("Event tracking is only available in platform mode.");
            return;
          }
          const results = await backend.listEvents();
          if (!results.length) {
            console.log("No events found.");
            return;
          }
          const header = [
            "Event ID".padEnd(36),
            "Type".padEnd(14),
            "Status".padEnd(12),
            "Latency".padStart(10),
            "Created".padEnd(20)
          ].join("  ");
          console.log(header);
          console.log("-".repeat(header.length));
          for (const ev of results) {
            const evId = String(ev.id ?? "");
            const evType = String(ev.event_type ?? "\u2014").padEnd(14);
            const status = String(ev.status ?? "\u2014").padEnd(12);
            const latency = typeof ev.latency === "number" ? `${Math.round(ev.latency)}ms` : "\u2014";
            const created = String(ev.created_at ?? "\u2014").slice(0, 19).replace("T", " ");
            console.log(
              `${evId.padEnd(36)}  ${evType}  ${status}  ${latency.padStart(10)}  ${created}`
            );
          }
          console.log(`
${results.length} event${results.length !== 1 ? "s" : ""}`);
        } catch (err) {
          console.error(`Failed to list events: ${String(err)}`);
        }
      });
      eventCmd.command("status").description("Get status of a specific background event").argument("<event_id>", "Event ID to check").action(async (eventId) => {
        try {
          if (!backend || cfg.mode === "open-source") {
            console.log("Event tracking is only available in platform mode.");
            return;
          }
          const ev = await backend.getEvent(eventId);
          const status = String(ev.status ?? "\u2014");
          const evType = String(ev.event_type ?? "\u2014");
          const latency = typeof ev.latency === "number" ? `${Math.round(ev.latency)}ms` : "\u2014";
          const created = String(ev.created_at ?? "\u2014").slice(0, 19).replace("T", " ");
          const updated = String(ev.updated_at ?? "\u2014").slice(0, 19).replace("T", " ");
          console.log(`Event ID:  ${eventId}`);
          console.log(`Type:      ${evType}`);
          console.log(`Status:    ${status}`);
          console.log(`Latency:   ${latency}`);
          console.log(`Created:   ${created}`);
          console.log(`Updated:   ${updated}`);
          const results = ev.results;
          if (results && Array.isArray(results) && results.length) {
            console.log(`
Results (${results.length}):`);
            for (const r of results) {
              const memId = String(r.id ?? "").slice(0, 8);
              const data = r.data;
              const memory = data?.memory ?? "";
              const evName = String(r.event ?? "");
              const user = String(r.user_id ?? "");
              let detail = `${evName}  ${memory}`;
              if (user) detail += `  (user_id=${user})`;
              console.log(`  \xB7 ${detail}  (${memId})`);
            }
          }
        } catch (err) {
          console.error(`Failed to get event: ${String(err)}`);
        }
      });
      mem0.command("help").description("Show help. Use --json for machine-readable output (for LLM agents)").option("--json", "Output as JSON for agent/programmatic use").action((opts) => {
        const commands = {
          memory: {
            search: "Query your memory store \u2014 semantic, keyword, or hybrid retrieval",
            add: "Add a memory from text, messages, or stdin",
            get: "Get a specific memory by ID",
            list: "List memories with optional filters",
            update: "Update a memory's text or metadata",
            delete: "Delete a memory, all memories, or an entity",
            import: "Import memories from a JSON file"
          },
          management: {
            init: "Interactive setup wizard for mem0 CLI",
            status: "Check connectivity and authentication",
            config: "Manage mem0 configuration (show, get, set)",
            event: "Manage background processing events (list, status)",
            dream: "Run memory consolidation (review, merge, prune)",
            help: "Show help. Use --json for machine-readable output (for LLM agents)"
          }
        };
        if (opts.json) {
          console.log(JSON.stringify({ commands }, null, 2));
          return;
        }
        console.log("");
        console.log("  openclaw mem0 <command>");
        console.log("");
        console.log("  Memory:");
        for (const [cmd, desc] of Object.entries(commands.memory)) {
          console.log(`    ${cmd.padEnd(12)} ${desc}`);
        }
        console.log("");
        console.log("  Management:");
        for (const [cmd, desc] of Object.entries(commands.management)) {
          console.log(`    ${cmd.padEnd(12)} ${desc}`);
        }
        console.log("");
      });
      mem0.command("dream").description(
        "Run memory consolidation (review, merge, prune stored memories)"
      ).option(
        "--dry-run",
        "Show memory inventory without running consolidation"
      ).action(async (opts) => {
        try {
          const uid = cfg.userId;
          const memories = await provider.getAll({
            user_id: uid,
            source: "OPENCLAW"
          });
          const count = Array.isArray(memories) ? memories.length : 0;
          if (count === 0) {
            console.log("No memories to consolidate.");
            return;
          }
          const catCounts = /* @__PURE__ */ new Map();
          for (const mem of memories) {
            const cat = mem.metadata?.category ?? mem.categories?.[0] ?? "uncategorized";
            catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
          }
          process.stderr.write(`
Memory inventory for "${uid}":
`);
          for (const [cat, num] of [...catCounts.entries()].sort(
            (a, b) => b[1] - a[1]
          )) {
            process.stderr.write(`  ${cat}: ${num}
`);
          }
          process.stderr.write(`  TOTAL: ${count}

`);
          if (opts.dryRun) {
            process.stderr.write("Dry run \u2014 no changes made.\n");
            return;
          }
          const dreamPrompt = loadDreamPrompt(cfg.skills ?? {});
          if (!dreamPrompt) {
            process.stderr.write(
              "Dream skill file not found at skills/memory-dream/SKILL.md\n"
            );
            return;
          }
          const memoryDump = memories.map((m, i) => {
            const cat = m.metadata?.category ?? m.categories?.[0] ?? "uncategorized";
            const imp = m.metadata?.importance ?? "?";
            const created = m.created_at ?? "unknown";
            return `${i + 1}. [${m.id}] (${cat}, importance: ${imp}, created: ${created}) ${m.memory}`;
          }).join("\n");
          const fullPrompt = [
            "<dream-protocol>",
            dreamPrompt,
            "</dream-protocol>",
            "",
            `<all-memories count="${count}" user="${uid}">`,
            memoryDump,
            "</all-memories>",
            "",
            "Begin consolidation. Review all memories above and execute merge, delete, and rewrite operations using the available tools."
          ].join("\n");
          process.stdout.write(fullPrompt + "\n");
          process.stderr.write(
            `Dream prompt written to stdout (${fullPrompt.length} chars). Paste it into an OpenClaw session to run consolidation.
`
          );
        } catch (err) {
          console.error(`Dream failed: ${String(err)}`);
        }
      });
    },
    {
      descriptors: [
        { name: "mem0", description: "Mem0 memory plugin commands", hasSubcommands: true }
      ]
    }
  );
}

// tools/memory-search.ts
import { Type } from "@sinclair/typebox";
function createMemorySearchTool(deps) {
  const { cfg, provider, resolveUserId: resolveUserId3, buildSearchOptions, getCurrentSessionId } = deps;
  return {
    name: "memory_search",
    label: "Memory Search",
    description: "Search through long-term memories stored in Mem0.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: `Max results (default: ${cfg.topK})` })),
      userId: Type.Optional(Type.String({ description: "User ID to scope search" })),
      agentId: Type.Optional(Type.String({ description: "Agent ID to search a specific agent's memories" })),
      scope: Type.Optional(
        Type.Union([Type.Literal("session"), Type.Literal("long-term"), Type.Literal("all")], {
          description: 'Scope: "long-term" (default), "session", or "all"'
        })
      ),
      categories: Type.Optional(Type.Array(Type.String(), { description: "Filter by category" })),
      filters: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Advanced filters" }))
    }),
    async execute(_toolCallId, params) {
      const {
        query,
        limit,
        userId,
        agentId,
        scope = "long-term",
        categories: filterCategories,
        filters: agentFilters
      } = params;
      const start = Date.now();
      try {
        let results = [];
        const uid = resolveUserId3({ agentId, userId });
        const currentSessionId = getCurrentSessionId();
        const applyFilters = (opts) => {
          if (filterCategories?.length) opts.categories = filterCategories;
          if (agentFilters) opts.filters = agentFilters;
          return opts;
        };
        if (scope === "session") {
          if (currentSessionId) {
            results = await provider.search(query, applyFilters(buildSearchOptions(uid, limit, currentSessionId)));
          }
        } else if (scope === "long-term") {
          results = await provider.search(query, applyFilters(buildSearchOptions(uid, limit)));
        } else {
          const longTerm = await provider.search(query, applyFilters(buildSearchOptions(uid, limit)));
          let session = [];
          if (currentSessionId) {
            session = await provider.search(query, applyFilters(buildSearchOptions(uid, limit, currentSessionId)));
          }
          const seen = new Set(longTerm.map((r) => r.id));
          results = [...longTerm, ...session.filter((r) => !seen.has(r.id))];
        }
        deps.captureToolEvent("memory_search", { success: true, latency_ms: Date.now() - start, result_count: results.length });
        if (!results || results.length === 0) {
          return { content: [{ type: "text", text: "No relevant memories found." }], details: { count: 0 } };
        }
        const text = results.map(
          (r, i) => `${i + 1}. ${r.memory} (score: ${((r.score ?? 0) * 100).toFixed(0)}%, id: ${r.id})`
        ).join("\n");
        return {
          content: [{ type: "text", text: `Found ${results.length} memories:

${text}` }],
          details: {
            count: results.length,
            memories: results.map((r) => ({ id: r.id, memory: r.memory, score: r.score, categories: r.categories, created_at: r.created_at }))
          }
        };
      } catch (err) {
        deps.captureToolEvent("memory_search", { success: false, latency_ms: Date.now() - start, error: String(err) });
        return { content: [{ type: "text", text: `Memory search failed: ${String(err)}` }], details: { error: String(err) } };
      }
    }
  };
}

// tools/memory-add.ts
import { Type as Type2 } from "@sinclair/typebox";
function createMemoryAddTool(deps) {
  const { api, cfg, provider, resolveUserId: resolveUserId3, getCurrentSessionId, buildAddOptions, buildSearchOptions, skillsActive } = deps;
  return {
    name: "memory_add",
    label: "Memory Add",
    description: "Save important information in long-term memory via Mem0. Use for preferences, facts, decisions, and anything worth remembering.",
    parameters: Type2.Object({
      text: Type2.Optional(Type2.String({ description: "Single fact to remember" })),
      facts: Type2.Optional(Type2.Array(Type2.String(), { description: "Array of facts to store. ALL must share the same category." })),
      category: Type2.Optional(Type2.String({ description: 'Category: "identity", "preference", "decision", "rule", "project", "configuration", "technical", "relationship"' })),
      importance: Type2.Optional(Type2.Number({ description: "Importance (0.0-1.0), omit for category default" })),
      userId: Type2.Optional(Type2.String({ description: "User ID to scope this memory" })),
      agentId: Type2.Optional(Type2.String({ description: "Agent ID namespace" })),
      metadata: Type2.Optional(Type2.Record(Type2.String(), Type2.Unknown(), { description: "Additional metadata" })),
      longTerm: Type2.Optional(Type2.Boolean({ description: "Long-term (default: true). Set false for session-scoped." }))
    }),
    async execute(_toolCallId, params) {
      const p = params;
      const allFacts = p.facts?.length ? p.facts : p.text ? [p.text] : [];
      if (allFacts.length === 0) {
        return { content: [{ type: "text", text: "No facts provided. Pass 'text' or 'facts' array." }], details: { error: "missing_facts" } };
      }
      const start = Date.now();
      try {
        const currentSessionId = getCurrentSessionId();
        if (isSubagentSession(currentSessionId)) {
          return { content: [{ type: "text", text: "Memory storage is not available in subagent sessions." }], details: { error: "subagent_blocked" } };
        }
        const uid = resolveUserId3({ agentId: p.agentId, userId: p.userId });
        const runId = !(p.longTerm ?? true) && currentSessionId ? currentSessionId : void 0;
        if (skillsActive) {
          const rawMetadata = p.metadata;
          const category = p.category ?? rawMetadata?.category;
          const importance = p.importance ?? rawMetadata?.importance;
          const parsedMetadata = {
            ...rawMetadata ?? {},
            ...category && { category },
            ...importance !== void 0 && { importance }
          };
          const categories = resolveCategories(cfg.skills);
          const catConfig = category ? categories[category] : void 0;
          const expirationDate = catConfig ? ttlToExpirationDate(catConfig.ttl) : void 0;
          const isImmutable = catConfig?.immutable ?? false;
          const addOpts = {
            user_id: uid,
            source: "OPENCLAW",
            infer: false,
            deduced_memories: allFacts,
            metadata: parsedMetadata ?? {},
            ...expirationDate && { expiration_date: expirationDate },
            ...isImmutable && { immutable: true }
          };
          if (runId) addOpts.run_id = runId;
          if (cfg.mode === "platform") {
            addOpts.output_format = "v1.1";
          }
          const result2 = await provider.add([{ role: "user", content: allFacts.join("\n") }], addOpts);
          const count = result2.results?.length ?? 0;
          api.logger.info(`openclaw-mem0: stored ${count} memor${count === 1 ? "y" : "ies"} (infer=false, category=${category ?? "none"})`);
          deps.captureToolEvent("memory_add", { success: true, latency_ms: Date.now() - start, fact_count: allFacts.length, mode: "skills" });
          return {
            content: [{ type: "text", text: `Stored ${allFacts.length} fact(s) [${category ?? "uncategorized"}]: ${allFacts.map((f) => `"${f.slice(0, 60)}${f.length > 60 ? "..." : ""}"`).join(", ")}` }],
            details: { action: "stored", mode: "skills", category, factCount: allFacts.length, results: result2.results }
          };
        }
        const combinedText = allFacts.join("\n");
        const dedupOpts = buildSearchOptions(uid, 3);
        dedupOpts.threshold = 0.85;
        await provider.search(combinedText.slice(0, 200), dedupOpts);
        const result = await provider.add([{ role: "user", content: combinedText }], buildAddOptions(uid, runId, currentSessionId));
        const added = result.results?.filter((r) => r.event === "ADD") ?? [];
        const updated = result.results?.filter((r) => r.event === "UPDATE") ?? [];
        const summary = [];
        if (added.length > 0) summary.push(`${added.length} added`);
        if (updated.length > 0) summary.push(`${updated.length} updated`);
        if (summary.length === 0) summary.push("No new memories extracted");
        deps.captureToolEvent("memory_add", { success: true, latency_ms: Date.now() - start, fact_count: allFacts.length });
        return {
          content: [{ type: "text", text: `Stored: ${summary.join(", ")}. ${result.results?.map((r) => `[${r.event}] ${r.memory}`).join("; ") ?? ""}` }],
          details: { action: "stored", results: result.results }
        };
      } catch (err) {
        deps.captureToolEvent("memory_add", { success: false, latency_ms: Date.now() - start, error: String(err) });
        return { content: [{ type: "text", text: `Memory add failed: ${String(err)}` }], details: { error: String(err) } };
      }
    }
  };
}

// tools/memory-get.ts
import { Type as Type3 } from "@sinclair/typebox";
function createMemoryGetTool(deps) {
  const { provider } = deps;
  return {
    name: "memory_get",
    label: "Memory Get",
    description: "Retrieve a specific memory by its ID from Mem0.",
    parameters: Type3.Object({
      memoryId: Type3.String({ description: "The memory ID to retrieve" })
    }),
    async execute(_toolCallId, params) {
      const { memoryId } = params;
      const start = Date.now();
      try {
        const memory = await provider.get(memoryId);
        deps.captureToolEvent("memory_get", { success: true, latency_ms: Date.now() - start });
        return {
          content: [{ type: "text", text: `Memory ${memory.id}:
${memory.memory}

Created: ${memory.created_at ?? "unknown"}
Updated: ${memory.updated_at ?? "unknown"}` }],
          details: { memory }
        };
      } catch (err) {
        deps.captureToolEvent("memory_get", { success: false, latency_ms: Date.now() - start, error: String(err) });
        return { content: [{ type: "text", text: `Memory get failed: ${String(err)}` }], details: { error: String(err) } };
      }
    }
  };
}

// tools/memory-list.ts
import { Type as Type4 } from "@sinclair/typebox";
function createMemoryListTool(deps) {
  const { provider, resolveUserId: resolveUserId3, getCurrentSessionId } = deps;
  return {
    name: "memory_list",
    label: "Memory List",
    description: "List all stored memories for a user or agent.",
    parameters: Type4.Object({
      userId: Type4.Optional(Type4.String({ description: "User ID (default: configured)" })),
      agentId: Type4.Optional(Type4.String({ description: "Agent ID namespace" })),
      scope: Type4.Optional(
        Type4.Union([Type4.Literal("session"), Type4.Literal("long-term"), Type4.Literal("all")], {
          description: 'Scope: "all" (default), "session", or "long-term"'
        })
      )
    }),
    async execute(_toolCallId, params) {
      const { userId, agentId, scope = "all" } = params;
      const start = Date.now();
      try {
        let memories = [];
        const uid = resolveUserId3({ agentId, userId });
        const currentSessionId = getCurrentSessionId();
        if (scope === "session") {
          if (currentSessionId) memories = await provider.getAll({ user_id: uid, run_id: currentSessionId, source: "OPENCLAW" });
        } else if (scope === "long-term") {
          memories = await provider.getAll({ user_id: uid, source: "OPENCLAW" });
        } else {
          const longTerm = await provider.getAll({ user_id: uid, source: "OPENCLAW" });
          let session = [];
          if (currentSessionId) session = await provider.getAll({ user_id: uid, run_id: currentSessionId, source: "OPENCLAW" });
          const seen = new Set(longTerm.map((r) => r.id));
          memories = [...longTerm, ...session.filter((r) => !seen.has(r.id))];
        }
        deps.captureToolEvent("memory_list", { success: true, latency_ms: Date.now() - start, result_count: memories.length });
        if (!memories || memories.length === 0) {
          return { content: [{ type: "text", text: "No memories stored yet." }], details: { count: 0 } };
        }
        const text = memories.map((r, i) => `${i + 1}. ${r.memory} (id: ${r.id})`).join("\n");
        return {
          content: [{ type: "text", text: `${memories.length} memories:

${text}` }],
          details: {
            count: memories.length,
            memories: memories.map((r) => ({ id: r.id, memory: r.memory, categories: r.categories, created_at: r.created_at }))
          }
        };
      } catch (err) {
        deps.captureToolEvent("memory_list", { success: false, latency_ms: Date.now() - start, error: String(err) });
        return { content: [{ type: "text", text: `Memory list failed: ${String(err)}` }], details: { error: String(err) } };
      }
    }
  };
}

// tools/memory-update.ts
import { Type as Type5 } from "@sinclair/typebox";
function createMemoryUpdateTool(deps) {
  const { api, provider, getCurrentSessionId } = deps;
  return {
    name: "memory_update",
    label: "Memory Update",
    description: "Update an existing memory's text in place. Atomic and preserves history.",
    parameters: Type5.Object({
      memoryId: Type5.String({ description: "The memory ID to update" }),
      text: Type5.String({ description: "The new text (replaces old)" })
    }),
    async execute(_toolCallId, params) {
      const { memoryId, text } = params;
      const start = Date.now();
      try {
        if (isSubagentSession(getCurrentSessionId())) {
          return { content: [{ type: "text", text: "Memory update is not available in subagent sessions." }], details: { error: "subagent_blocked" } };
        }
        await provider.update(memoryId, text);
        deps.captureToolEvent("memory_update", { success: true, latency_ms: Date.now() - start });
        return {
          content: [{ type: "text", text: `Updated memory ${memoryId}: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"` }],
          details: { action: "updated", id: memoryId }
        };
      } catch (err) {
        deps.captureToolEvent("memory_update", { success: false, latency_ms: Date.now() - start, error: String(err) });
        return { content: [{ type: "text", text: `Memory update failed: ${String(err)}` }], details: { error: String(err) } };
      }
    }
  };
}

// tools/memory-delete.ts
import { Type as Type6 } from "@sinclair/typebox";
function createMemoryDeleteTool(deps) {
  const { api, provider, resolveUserId: resolveUserId3, getCurrentSessionId, buildSearchOptions } = deps;
  return {
    name: "memory_delete",
    label: "Memory Delete",
    description: "Delete memories. Provide memoryId, query to search-and-delete, or all:true for bulk deletion (requires confirm:true).",
    parameters: Type6.Object({
      memoryId: Type6.Optional(Type6.String({ description: "Specific memory ID to delete" })),
      query: Type6.Optional(Type6.String({ description: "Search query to find and delete" })),
      agentId: Type6.Optional(Type6.String({ description: "Agent ID to scope deletion" })),
      all: Type6.Optional(Type6.Boolean({ description: "Delete ALL memories. Requires confirm: true." })),
      confirm: Type6.Optional(Type6.Boolean({ description: "Safety gate for bulk operations" })),
      userId: Type6.Optional(Type6.String({ description: "User ID scope" }))
    }),
    async execute(_toolCallId, params) {
      const { memoryId, query, agentId, all, confirm, userId } = params;
      const start = Date.now();
      try {
        if (isSubagentSession(getCurrentSessionId())) {
          return { content: [{ type: "text", text: "Memory deletion is not available in subagent sessions." }], details: { error: "subagent_blocked" } };
        }
        if (memoryId) {
          await provider.delete(memoryId);
          deps.captureToolEvent("memory_delete", { success: true, latency_ms: Date.now() - start, delete_mode: "single" });
          return { content: [{ type: "text", text: `Memory ${memoryId} deleted.` }], details: { action: "deleted", id: memoryId } };
        }
        if (query) {
          const uid = resolveUserId3({ agentId, userId });
          const results = await provider.search(query, buildSearchOptions(uid, 5));
          if (!results || results.length === 0) {
            return { content: [{ type: "text", text: "No matching memories found." }], details: { found: 0 } };
          }
          if (results.length === 1 || (results[0].score ?? 0) > 0.9) {
            await provider.delete(results[0].id);
            return { content: [{ type: "text", text: `Deleted: "${results[0].memory}"` }], details: { action: "deleted", id: results[0].id } };
          }
          const list = results.map(
            (r) => `- [${r.id}] ${r.memory.slice(0, 80)}${r.memory.length > 80 ? "..." : ""} (${((r.score ?? 0) * 100).toFixed(0)}%)`
          ).join("\n");
          return {
            content: [{ type: "text", text: `Found ${results.length} candidates. Specify memoryId:
${list}` }],
            details: { action: "candidates", candidates: results.map((r) => ({ id: r.id, memory: r.memory, score: r.score })) }
          };
        }
        if (all) {
          if (!confirm) {
            return { content: [{ type: "text", text: "Bulk deletion requires confirm: true." }], details: { error: "confirmation_required" } };
          }
          const uid = resolveUserId3({ agentId, userId });
          await provider.deleteAll(uid);
          deps.captureToolEvent("memory_delete", { success: true, latency_ms: Date.now() - start, delete_mode: "all" });
          api.logger.info(`openclaw-mem0: deleted all memories for user ${uid}`);
          return { content: [{ type: "text", text: `All memories deleted for user "${uid}".` }], details: { action: "deleted_all", user_id: uid } };
        }
        return { content: [{ type: "text", text: "Provide memoryId, query, or all:true." }], details: { error: "missing_param" } };
      } catch (err) {
        deps.captureToolEvent("memory_delete", { success: false, latency_ms: Date.now() - start, error: String(err) });
        return { content: [{ type: "text", text: `Memory delete failed: ${String(err)}` }], details: { error: String(err) } };
      }
    }
  };
}

// tools/memory-event-list.ts
import { Type as Type7 } from "@sinclair/typebox";
function createMemoryEventListTool(deps) {
  return {
    name: "memory_event_list",
    label: "Memory Event List",
    description: "List recent background processing events from the Mem0 Platform. Use to check whether memory operations (add, update, delete) were processed successfully.",
    parameters: Type7.Object({}),
    async execute(_toolCallId, _params) {
      const start = Date.now();
      try {
        if (!deps.backend) {
          deps.captureToolEvent("memory_event_list", { success: false, latency_ms: 0, error: "not_platform" });
          return {
            content: [{ type: "text", text: "Event tracking is only available in platform mode." }],
            details: { error: "not_platform" }
          };
        }
        const results = await deps.backend.listEvents();
        if (!results.length) {
          deps.captureToolEvent("memory_event_list", { success: true, latency_ms: Date.now() - start, count: 0 });
          return {
            content: [{ type: "text", text: "No events found." }],
            details: { count: 0 }
          };
        }
        const rows = results.map((ev) => {
          const evId = String(ev.id ?? "");
          const evType = String(ev.event_type ?? "\u2014");
          const status = String(ev.status ?? "\u2014");
          const latency = typeof ev.latency === "number" ? `${Math.round(ev.latency)}ms` : "\u2014";
          const created = String(ev.created_at ?? "\u2014").slice(0, 19).replace("T", " ");
          return { id: evId, type: evType, status, latency, created };
        });
        const text = rows.map((r) => `- ${r.id} | ${r.type} | ${r.status} | ${r.latency} | ${r.created}`).join("\n");
        deps.captureToolEvent("memory_event_list", { success: true, latency_ms: Date.now() - start, count: results.length });
        return {
          content: [{ type: "text", text: `${results.length} event(s):
${text}` }],
          details: { count: results.length, events: rows }
        };
      } catch (err) {
        deps.captureToolEvent("memory_event_list", { success: false, latency_ms: Date.now() - start, error: String(err) });
        return {
          content: [{ type: "text", text: `Failed to list events: ${String(err)}` }],
          details: { error: String(err) }
        };
      }
    }
  };
}

// tools/memory-event-status.ts
import { Type as Type8 } from "@sinclair/typebox";
function createMemoryEventStatusTool(deps) {
  return {
    name: "memory_event_status",
    label: "Memory Event Status",
    description: "Get detailed status of a specific background processing event. Use to verify whether a memory add/update/delete was processed, view latency, and inspect results.",
    parameters: Type8.Object({
      event_id: Type8.String({ description: "The event ID to check" })
    }),
    async execute(_toolCallId, params) {
      const { event_id: eventId } = params;
      const start = Date.now();
      try {
        if (!deps.backend) {
          deps.captureToolEvent("memory_event_status", { success: false, latency_ms: 0, error: "not_platform" });
          return {
            content: [{ type: "text", text: "Event tracking is only available in platform mode." }],
            details: { error: "not_platform" }
          };
        }
        const ev = await deps.backend.getEvent(eventId);
        const status = String(ev.status ?? "\u2014");
        const evType = String(ev.event_type ?? "\u2014");
        const latency = typeof ev.latency === "number" ? `${Math.round(ev.latency)}ms` : "\u2014";
        const created = String(ev.created_at ?? "\u2014").slice(0, 19).replace("T", " ");
        const updated = String(ev.updated_at ?? "\u2014").slice(0, 19).replace("T", " ");
        let text = `Event: ${eventId}
Type: ${evType}
Status: ${status}
Latency: ${latency}
Created: ${created}
Updated: ${updated}`;
        const results = ev.results;
        if (results && Array.isArray(results) && results.length) {
          const resultLines = results.map((r) => {
            const memId = String(r.id ?? "").slice(0, 8);
            const data = r.data;
            const memory = data?.memory ?? "";
            const evName = String(r.event ?? "");
            return `- [${evName}] ${memory} (${memId})`;
          });
          text += `

Results (${results.length}):
${resultLines.join("\n")}`;
        }
        deps.captureToolEvent("memory_event_status", { success: true, latency_ms: Date.now() - start });
        return {
          content: [{ type: "text", text }],
          details: { event: ev }
        };
      } catch (err) {
        deps.captureToolEvent("memory_event_status", { success: false, latency_ms: Date.now() - start, error: String(err) });
        return {
          content: [{ type: "text", text: `Failed to get event: ${String(err)}` }],
          details: { error: String(err) }
        };
      }
    }
  };
}

// tools/index.ts
function registerAllTools(deps) {
  const { api } = deps;
  api.registerTool(createMemorySearchTool(deps));
  api.registerTool(createMemoryAddTool(deps));
  api.registerTool(createMemoryGetTool(deps));
  api.registerTool(createMemoryListTool(deps));
  api.registerTool(createMemoryUpdateTool(deps));
  api.registerTool(createMemoryDeleteTool(deps));
  api.registerTool(createMemoryEventListTool(deps));
  api.registerTool(createMemoryEventStatusTool(deps));
}

// index.ts
bootstrapTelemetryFlag();
var memoryPlugin = definePluginEntry({
  id: "openclaw-mem0",
  name: "Memory (Mem0)",
  description: "Mem0 memory backend \u2014 Mem0 platform or self-hosted open-source",
  register(api) {
    const pluginAuth = readPluginAuth();
    const fileConfig = {
      apiKey: pluginAuth.apiKey,
      baseUrl: pluginAuth.baseUrl
    };
    const cfg = mem0ConfigSchema.parse(api.pluginConfig, fileConfig);
    const telemetryCtx = {
      apiKey: cfg.apiKey,
      mode: cfg.mode,
      skillsActive: false
    };
    const _captureEvent = (event, props) => {
      try {
        captureEvent(event, props, telemetryCtx);
      } catch {
      }
    };
    if (cfg.needsSetup) {
      api.logger.warn(
        "openclaw-mem0: API key not configured. Memory features are disabled.\n  To set up, run:\n  openclaw mem0 init\n  Get your key at: https://app.mem0.ai/dashboard/api-keys"
      );
      registerCliCommands(
        api,
        null,
        null,
        cfg,
        () => cfg.userId,
        (id) => `${cfg.userId}:agent:${id}`,
        () => ({ user_id: cfg.userId, top_k: cfg.topK }),
        () => void 0,
        (cmd) => _captureEvent(`openclaw.cli.${cmd}`, { command: cmd })
      );
      api.registerService({
        id: "openclaw-mem0",
        start: () => {
          api.logger.info("openclaw-mem0: waiting for API key configuration");
        },
        stop: () => {
        }
      });
      return;
    }
    const provider = createProvider(cfg, api);
    let backend;
    if (cfg.mode === "platform") {
      backend = new PlatformBackend({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl ?? "https://api.mem0.ai"
      });
    } else {
      backend = providerToBackend(provider, cfg.userId);
    }
    let currentSessionId;
    let pluginStateDir;
    const _effectiveUserId = (sessionKey) => effectiveUserId(cfg.userId, sessionKey);
    const _agentUserId = (id) => agentUserId(cfg.userId, id);
    const _resolveUserId = (opts) => resolveUserId(cfg.userId, opts, currentSessionId);
    const skillsActive = isSkillsMode(cfg.skills);
    telemetryCtx.skillsActive = skillsActive;
    _captureEvent("openclaw.plugin.registered", {
      auto_recall: cfg.autoRecall,
      auto_capture: cfg.autoCapture
    });
    api.logger.info(
      `openclaw-mem0: registered (mode: ${cfg.mode}, user: ${cfg.userId}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}, skills: ${skillsActive})`
    );
    function buildAddOptions(userIdOverride, runId, sessionKey) {
      const opts = {
        user_id: userIdOverride || _effectiveUserId(sessionKey),
        source: "OPENCLAW"
      };
      if (runId) opts.run_id = runId;
      if (cfg.mode === "platform") {
        opts.output_format = "v1.1";
      }
      return opts;
    }
    function buildSearchOptions(userIdOverride, limit, runId, sessionKey) {
      const recallCfg = cfg.skills?.recall;
      const opts = {
        user_id: userIdOverride || _effectiveUserId(sessionKey),
        top_k: limit ?? cfg.topK,
        limit: limit ?? cfg.topK,
        threshold: recallCfg?.threshold ?? cfg.searchThreshold,
        keyword_search: recallCfg?.keywordSearch !== false,
        reranking: recallCfg?.rerank !== false,
        source: "OPENCLAW"
      };
      if (recallCfg?.filterMemories) opts.filter_memories = true;
      if (runId) opts.run_id = runId;
      return opts;
    }
    const toolDeps = {
      api,
      provider,
      cfg,
      backend,
      resolveUserId: _resolveUserId,
      effectiveUserId: _effectiveUserId,
      agentUserId: _agentUserId,
      buildAddOptions,
      buildSearchOptions,
      getCurrentSessionId: () => currentSessionId,
      skillsActive,
      captureToolEvent: (toolName, props) => {
        _captureEvent(`openclaw.tool.${toolName}`, {
          tool_name: toolName,
          ...props
        });
      }
    };
    registerAllTools(toolDeps);
    registerCliCommands(
      api,
      backend,
      provider,
      cfg,
      _effectiveUserId,
      _agentUserId,
      buildSearchOptions,
      () => currentSessionId,
      (cmd) => _captureEvent(`openclaw.cli.${cmd}`, { command: cmd })
    );
    registerHooks(
      api,
      provider,
      cfg,
      _effectiveUserId,
      buildAddOptions,
      buildSearchOptions,
      {
        setCurrentSessionId: (id) => {
          currentSessionId = id;
        },
        getStateDir: () => pluginStateDir
      },
      skillsActive,
      _captureEvent
    );
    api.registerService({
      id: "openclaw-mem0",
      start: (...args) => {
        pluginStateDir = args[0]?.stateDir;
        api.logger.info(
          `openclaw-mem0: initialized (mode: ${cfg.mode}, user: ${cfg.userId}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}, stateDir: ${pluginStateDir ?? "none"})`
        );
      },
      stop: () => {
        api.logger.info("openclaw-mem0: stopped");
      }
    });
  }
});
function registerHooks(api, provider, cfg, _effectiveUserId, buildAddOptions, buildSearchOptions, session, skillsActive = false, _captureEvent = () => {
}) {
  if (skillsActive) {
    api.on("before_prompt_build", async (event, ctx) => {
      if (!event.prompt || event.prompt.length < 5) return;
      const trigger = ctx?.trigger ?? void 0;
      const sessionId = ctx?.sessionKey ?? void 0;
      if (isNonInteractiveTrigger(trigger, sessionId)) {
        api.logger.info(
          "openclaw-mem0: skills-mode skipping non-interactive trigger"
        );
        return;
      }
      const promptLower = event.prompt.toLowerCase();
      const isSystemPrompt = promptLower.includes("a new session was started") || promptLower.includes("session startup sequence") || promptLower.includes("/new or /reset") || promptLower.startsWith("run your session");
      if (isSystemPrompt) {
        api.logger.info(
          "openclaw-mem0: skills-mode skipping recall for system/bootstrap prompt"
        );
        const systemContext2 = loadTriagePrompt(cfg.skills ?? {});
        return { prependSystemContext: systemContext2 };
      }
      if (sessionId) session.setCurrentSessionId(sessionId);
      const isSubagent = isSubagentSession(sessionId);
      const userId = _effectiveUserId(isSubagent ? void 0 : sessionId);
      let systemContext = loadTriagePrompt(cfg.skills ?? {});
      if (isSubagent) {
        systemContext = "You are a subagent \u2014 use these memories for context but do not assume you are this user. Do NOT store new memories.\n\n" + systemContext;
      }
      let recallContext = "";
      const recallEnabled = cfg.skills?.recall?.enabled !== false;
      const recallStrategy = cfg.skills?.recall?.strategy ?? "smart";
      if (recallEnabled && recallStrategy !== "manual") {
        const recallStart = Date.now();
        try {
          const query = sanitizeQuery(event.prompt);
          const sessionIdForRecall = recallStrategy === "always" ? isSubagent ? void 0 : sessionId : void 0;
          const recallResult = await recall(
            provider,
            query,
            userId,
            cfg.skills ?? {},
            sessionIdForRecall
          );
          api.logger.info(
            `openclaw-mem0: skills-mode recall (strategy=${recallStrategy}) injecting ${recallResult.memories.length} memories (~${recallResult.tokenEstimate} tokens)`
          );
          _captureEvent("openclaw.hook.recall", {
            strategy: recallStrategy,
            memory_count: recallResult.memories.length,
            latency_ms: Date.now() - recallStart
          });
          recallContext = recallResult.context;
        } catch (err) {
          api.logger.warn(
            `openclaw-mem0: skills-mode recall failed: ${String(err)}`
          );
        }
      } else if (recallEnabled && recallStrategy === "manual") {
        api.logger.info(
          "openclaw-mem0: skills-mode recall strategy=manual, agent controls search"
        );
      }
      const stateDir = session.getStateDir();
      const dreamEnabled = cfg.skills?.dream?.enabled !== false && cfg.skills?.dream?.auto !== false;
      let dreamContext = "";
      if (dreamEnabled && stateDir && !isSubagent) {
        try {
          const cheapResult = checkCheapGates(
            stateDir,
            cfg.skills?.dream ?? {}
          );
          if (cheapResult.proceed) {
            const memories = await provider.getAll({
              user_id: userId,
              source: "OPENCLAW"
            });
            const memCount = Array.isArray(memories) ? memories.length : 0;
            const memResult = checkMemoryGate(
              memCount,
              cfg.skills?.dream ?? {}
            );
            if (memResult.pass && acquireDreamLock(stateDir)) {
              const dreamPrompt = loadDreamPrompt(cfg.skills ?? {});
              if (dreamPrompt) {
                dreamContext = "\n\n<auto-dream>\nIMPORTANT: Before responding to the user, run a memory consolidation pass. Follow the protocol below, then respond normally.\n\n" + dreamPrompt + "\n</auto-dream>";
                dreamSessionId = sessionId;
                _captureEvent("openclaw.hook.dream", {
                  phase: "triggered",
                  memory_count: memCount
                });
                api.logger.info(
                  `openclaw-mem0: auto-dream triggered (${memCount} memories, gate passed)`
                );
              } else {
                releaseDreamLock(stateDir);
              }
            }
          }
        } catch (err) {
          api.logger.warn(
            `openclaw-mem0: auto-dream gate check failed: ${String(err)}`
          );
        }
      }
      return {
        prependSystemContext: systemContext,
        // cached by provider
        prependContext: recallContext + dreamContext
        // per-turn dynamic
      };
    });
    let dreamSessionId;
    api.on("agent_end", async (event, ctx) => {
      const sessionId = ctx?.sessionKey ?? void 0;
      const trigger = ctx?.trigger ?? void 0;
      if (sessionId) session.setCurrentSessionId(sessionId);
      const stateDir = session.getStateDir();
      if (dreamSessionId && dreamSessionId === sessionId && stateDir) {
        dreamSessionId = void 0;
        if (!event.success) {
          releaseDreamLock(stateDir);
          api.logger.warn(
            "openclaw-mem0: auto-dream turn failed, lock released, will retry"
          );
          return;
        }
        const WRITE_TOOLS = /* @__PURE__ */ new Set([
          "memory_add",
          "memory_update",
          "memory_delete"
        ]);
        const messages = event.messages ?? [];
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        const writeToolUsed = lastAssistant && Array.isArray(lastAssistant.content) ? lastAssistant.content.some(
          (block) => block.type === "tool_use" && WRITE_TOOLS.has(block.name)
        ) : false;
        if (writeToolUsed) {
          releaseDreamLock(stateDir);
          recordDreamCompletion(stateDir);
          _captureEvent("openclaw.hook.dream", {
            phase: "completed",
            write_tools_used: true
          });
          api.logger.info(
            "openclaw-mem0: auto-dream completed (verified write tool usage), lock released"
          );
        } else {
          releaseDreamLock(stateDir);
          api.logger.warn(
            "openclaw-mem0: auto-dream injected but no write tools executed. Lock released, will retry."
          );
        }
        return;
      }
      if (!event.success) return;
      if (stateDir && sessionId && !isNonInteractiveTrigger(trigger, sessionId)) {
        incrementSessionCount(stateDir, sessionId);
      }
      api.logger.info("openclaw-mem0: skills-mode agent_end (no auto-capture)");
    });
    return;
  }
  let lastRecallSessionId;
  if (cfg.autoRecall) {
    const RECALL_TIMEOUT_MS = 3e4;
    api.on("before_prompt_build", async (event, ctx) => {
      if (!event.prompt || event.prompt.length < 5) return;
      const trigger = ctx?.trigger ?? void 0;
      const sessionId = ctx?.sessionKey ?? void 0;
      if (isNonInteractiveTrigger(trigger, sessionId)) {
        api.logger.info(
          "openclaw-mem0: skipping recall for non-interactive trigger"
        );
        return;
      }
      const promptLower = event.prompt.toLowerCase();
      const isSystemPrompt = promptLower.includes("a new session was started") || promptLower.includes("session startup sequence") || promptLower.includes("/new or /reset") || promptLower.startsWith("run your session");
      if (isSystemPrompt) {
        api.logger.info(
          "openclaw-mem0: skipping recall for system/bootstrap prompt"
        );
        return;
      }
      if (sessionId) session.setCurrentSessionId(sessionId);
      const isNewSession = sessionId !== void 0 && sessionId !== lastRecallSessionId;
      if (sessionId) lastRecallSessionId = sessionId;
      const isSubagent = isSubagentSession(sessionId);
      const recallSessionKey = isSubagent ? void 0 : sessionId;
      const cleanPrompt = event.prompt.replace(
        /Sender\s*\(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi,
        ""
      ).trim();
      const recallStart = Date.now();
      const recallWork = async () => {
        const recallTopK = Math.max((cfg.topK ?? 5) * 2, 10);
        let longTermResults = await provider.search(
          cleanPrompt,
          buildSearchOptions(
            void 0,
            recallTopK,
            void 0,
            recallSessionKey
          )
        );
        const recallThreshold = Math.max(cfg.searchThreshold, 0.6);
        longTermResults = longTermResults.filter(
          (r) => (r.score ?? 0) >= recallThreshold
        );
        if (longTermResults.length > 1) {
          const topScore = longTermResults[0]?.score ?? 0;
          if (topScore > 0) {
            longTermResults = longTermResults.filter(
              (r) => (r.score ?? 0) >= topScore * 0.5
            );
          }
        }
        if (isNewSession && cleanPrompt.length < 100) {
          const broadOpts = buildSearchOptions(
            void 0,
            5,
            void 0,
            recallSessionKey
          );
          broadOpts.threshold = 0.5;
          const broadResults = await provider.search(
            "recent decisions, preferences, active projects, and configuration",
            broadOpts
          );
          const existingIds = new Set(longTermResults.map((r) => r.id));
          for (const r of broadResults) {
            if (!existingIds.has(r.id)) {
              longTermResults.push(r);
            }
          }
        }
        longTermResults = longTermResults.slice(0, cfg.topK);
        if (longTermResults.length === 0) return void 0;
        const memoryContext = longTermResults.map(
          (r) => `- ${r.memory}${r.categories?.length ? ` [${r.categories.join(", ")}]` : ""}`
        ).join("\n");
        _captureEvent("openclaw.hook.recall", {
          strategy: "legacy",
          memory_count: longTermResults.length,
          latency_ms: Date.now() - recallStart
        });
        api.logger.info(
          `openclaw-mem0: injecting ${longTermResults.length} memories into context`
        );
        const preamble = isSubagent ? `The following are stored memories for user "${cfg.userId}". You are a subagent \u2014 use these memories for context but do not assume you are this user.` : `The following are stored memories for user "${cfg.userId}". Use them to personalize your response:`;
        return {
          prependContext: `<relevant-memories>
${preamble}
${memoryContext}
</relevant-memories>`
        };
      };
      try {
        const timeout = new Promise((resolve2) => {
          setTimeout(() => resolve2(void 0), RECALL_TIMEOUT_MS);
        });
        const result = await Promise.race([
          recallWork(),
          timeout.then(() => {
            api.logger.warn(
              `openclaw-mem0: recall timed out after ${RECALL_TIMEOUT_MS}ms, skipping`
            );
            return void 0;
          })
        ]);
        return result;
      } catch (err) {
        api.logger.warn(`openclaw-mem0: recall failed: ${String(err)}`);
      }
    });
  }
  if (cfg.autoCapture) {
    api.on("agent_end", async (event, ctx) => {
      if (!event.success || !event.messages || event.messages.length === 0) {
        return;
      }
      const trigger = ctx?.trigger ?? void 0;
      const sessionId = ctx?.sessionKey ?? void 0;
      if (isNonInteractiveTrigger(trigger, sessionId)) {
        api.logger.info(
          "openclaw-mem0: skipping capture for non-interactive trigger"
        );
        return;
      }
      if (isSubagentSession(sessionId)) {
        api.logger.info(
          "openclaw-mem0: skipping capture for subagent (main agent captures consolidated result)"
        );
        return;
      }
      if (sessionId) session.setCurrentSessionId(sessionId);
      const MEMORY_MUTATE_TOOLS = /* @__PURE__ */ new Set([
        "memory_add",
        "memory_update",
        "memory_delete"
      ]);
      const agentUsedMemoryTool = event.messages.some((msg) => {
        if (msg?.role !== "assistant" || !Array.isArray(msg?.content))
          return false;
        return msg.content.some(
          (block) => (block?.type === "tool_use" || block?.type === "toolCall") && MEMORY_MUTATE_TOOLS.has(block.name)
        );
      });
      if (agentUsedMemoryTool) {
        api.logger.info(
          "openclaw-mem0: skipping auto-capture \u2014 agent already used memory tools this turn"
        );
        return;
      }
      const SUMMARY_PATTERNS = [
        /## What I (Accomplished|Built|Updated)/i,
        /✅\s*(Done|Complete|All done)/i,
        /Here's (what I updated|the recap|a summary)/i,
        /### Changes Made/i,
        /Implementation Status/i,
        /All locked in\. Quick summary/i
      ];
      const allParsed = [];
      for (let i = 0; i < event.messages.length; i++) {
        const msg = event.messages[i];
        if (!msg || typeof msg !== "object") continue;
        const msgObj = msg;
        const role = msgObj.role;
        if (role !== "user" && role !== "assistant") continue;
        let textContent = "";
        const content = msgObj.content;
        if (typeof content === "string") {
          textContent = content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
              textContent += (textContent ? "\n" : "") + block.text;
            }
          }
        }
        if (!textContent) continue;
        if (textContent.includes("<relevant-memories>")) {
          textContent = textContent.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "").trim();
          if (!textContent) continue;
        }
                /* JARVIS_THINK_PATCH */
        if (textContent.includes("<think")) {
          textContent = textContent.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();
          if (!textContent) continue;
        }
if (textContent.includes("Sender") && textContent.includes("untrusted metadata")) {
          textContent = textContent.replace(
            /Sender\s*\(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi,
            ""
          ).trim();
          if (!textContent) continue;
        }
        const isSummary = role === "assistant" && SUMMARY_PATTERNS.some((p) => p.test(textContent));
        allParsed.push({
          role,
          content: textContent,
          index: i,
          isSummary
        });
      }
      if (allParsed.length === 0) return;
      const recentWindow = 20;
      const recentCutoff = allParsed.length - recentWindow;
      const candidates = [];
      for (const msg of allParsed) {
        if (msg.isSummary && msg.index < recentCutoff) {
          candidates.push(msg);
        }
      }
      const seenIndices = new Set(candidates.map((m) => m.index));
      for (const msg of allParsed) {
        if (msg.index >= recentCutoff && !seenIndices.has(msg.index)) {
          candidates.push(msg);
        }
      }
      candidates.sort((a, b) => a.index - b.index);
      const selected = candidates.map((m) => ({
        role: m.role,
        content: m.content
      }));
      const formattedMessages = filterMessagesForExtraction(selected);
      if (formattedMessages.length === 0) return;
      if (!formattedMessages.some((m) => m.role === "user")) return;
      const userContent = formattedMessages.filter((m) => m.role === "user").map((m) => m.content).join(" ");
      if (userContent.length < 50) {
        api.logger.info(
          "openclaw-mem0: skipping capture \u2014 user content too short for meaningful extraction"
        );
        return;
      }
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      formattedMessages.unshift({
        role: "system",
        content: `Current date: ${timestamp}. The user is identified as "${cfg.userId}". Extract durable facts from this conversation. Include this date when storing time-sensitive information.`
      });
      const addOpts = buildAddOptions(void 0, sessionId, sessionId);
      const captureStart = Date.now();
      provider.add(formattedMessages, addOpts).then((result) => {
        const capturedCount = result.results?.length ?? 0;
        _captureEvent("openclaw.hook.capture", {
          captured_count: capturedCount,
          latency_ms: Date.now() - captureStart
        });
        if (capturedCount > 0) {
          api.logger.info(
            `openclaw-mem0: auto-captured ${capturedCount} memories`
          );
        }
      }).catch((err) => {
        api.logger.warn(`openclaw-mem0: capture failed: ${String(err)}`);
      });
    });
  }
}
var index_default = memoryPlugin;
export {
  agentUserId,
  createProvider,
  index_default as default,
  effectiveUserId,
  extractAgentId,
  filterMessagesForExtraction,
  isGenericAssistantMessage,
  isNoiseMessage,
  isNonInteractiveTrigger,
  isSubagentSession,
  mem0ConfigSchema,
  resolveUserId,
  stripNoiseFromContent
};
//# sourceMappingURL=index.js.map