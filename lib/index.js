/**
 * dsh-web-search-workbuddy
 *
 * WorkBuddy gateway-backed search provider for the DSH web capability seam
 * (ctx.web). Bridges `ctx.web.search()` to the workbuddy2api-go gateway's
 * agenttool web-search passthrough endpoint (0057 patch) **through
 * workbuddy-manager**:
 *
 *   POST {baseURL}/v1/tools/search
 *   body: {
 *     "query": "...",
 *     "type": "text2text",
 *     "max_results": 5,
 *     "allowed_domains": ["go.dev"],
 *     "blocked_domains": ["reddit.com"],
 *     "freshness": "d1|m1|y1"
 *   }
 *   resp: {"code":0, "results":[{title,url,snippet}], ...}   (agenttool envelope passthrough)
 *         or {"error":"...", "code":"quota_web_search", ...} on 429 (all-pool 15001)
 *
 * The manager route forwards the body verbatim (no rewriting), and the 0057
 * gateway maps `allowed_domains`/`freshness`/`type` onto the upstream
 * `workbuddy.cn/agenttool/v1/search` request and appends `blocked_domains` to
 * the query text as `-site:<domain>` (official CLI semantics).
 *
 * ## Full parameter set (v0.4.0)
 *
 * The DSH web seam's `WebSearchRequest` only carries `query` + `maxResults`,
 * so the remaining agenttool parameters are supplied by this plugin's config
 * (deployment-level defaults). Every parameter also accepts a *per-request*
 * override on the search request object, in either camelCase or the upstream
 * snake_case spelling — this keeps the provider usable from a direct caller or
 * a future seam that exposes the extra fields, without patching DSH core:
 *
 *   | upstream /v1/tools/search | config key      | request override(s)                    |
 *   |---------------------------|-----------------|----------------------------------------|
 *   | query                     | (request)       | query                                  |
 *   | type                      | type            | type                                   |
 *   | max_results               | maxResults      | maxResults / max_results               |
 *   | allowed_domains           | allowedDomains  | allowedDomains / allowed_domains       |
 *   | blocked_domains           | blockedDomains  | blockedDomains / blocked_domains       |
 *   | freshness                 | freshness       | freshness                              |
 *
 * Empty domain lists / an unset freshness are omitted from the wire body;
 * `max_results` is clamped to 1..20 (the 0057 gateway's bound).
 *
 * Provider id registers as "workbuddy-gateway"; pin it with
 * `web.searchProvider: workbuddy-gateway` in the profile patch.
 *
 * ## Model-facing tool (v0.4.1, optional)
 *
 * The official `@deepseek-ai/dsh-tool-web` registers `web_search` with only
 * `queries` and drops every other argument before calling `ctx.web.search()`.
 * When `modelControlled: true`, this plugin registers its own `web_search`
 * tool (same name) with the extra agenttool parameters exposed to the model:
 *
 *   allowedDomains / blockedDomains / freshness / maxResults
 *
 * Assembly must disable the official registration in every `tool-web` entry
 * (`search: false`) — `ctx.tools.register()` rejects duplicate names. The
 * official `web_fetch` stays untouched. `ctx.web.search()` passes the request
 * object through unchanged, so the provider's per-request overrides map the
 * model's choices onto the gateway body without patching DSH core.
 *
 * When `modelControlled: false` (default), the plugin only registers the
 * provider; the official tool keeps working with the config-level defaults.
 *
 * ## Credential & endpoint resolution (zero-config by default)
 *
 * With no `baseURL`/`apiKeyEnv` in this plugin's config, both are **derived
 * from the model provider route the conversation is already using**: the
 * initiating session's `requestContext().provider` names a route (e.g.
 * `workbuddy-mannager-cn`), this plugin reads that route's profile from the
 * `llm-pi-ai` settings section (`llm.listConfigurableProviders()` →
 * `loader.entries()` → effective config, same mechanism as the official
 * `dsh-web-deepseek-api`), and takes its `apiKeyEnv` + `baseURL`.
 *
 * - `apiKeyEnv` resolution order: the route profile's `apiKeyEnv` credential
 *   reference (resolved via `ctx.credentials`, then the launch environment).
 * - `baseURL`: the route profile's `baseURL` with any `/v1/` suffix stripped
 *   (the chat route posts to `/v1/chat/completions`; search posts to
 *   `/v1/tools/search` on the same origin). A `credentialUrl`-shaped baseURL
 *   is rejected — this is not a per-model endpoint.
 *
 * Explicit config always wins (for deployments whose search endpoint differs
 * from the chat route); omit both fields and the assembly is three lines.
 */
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { WebError } from "@deepseek-ai/dsh-web";

/** Stable provider id this plugin registers under. */
const PROVIDER_ID = "workbuddy-gateway";

/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-workbuddy";

/** The web seam this provider registers into (tools/systemPrompt are optional). */
const inject = ["web"];

/** Loader package that owns the pi-ai provider profiles. */
const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

/** Fallback workbuddy-manager origin when neither explicit config nor route profile sets baseURL. */
const DEFAULT_BASE_URL = "http://127.0.0.1:7864";

/** agenttool `freshness` enum (d1 = day, m1 = month, y1 = year). */
const FRESHNESS_VALUES = ["d1", "m1", "y1"];

/** 0057 gateway / agenttool result-count bound. */
const MAX_RESULTS_CAP = 20;

const Config = z.object({
  /**
   * Gateway base. Omit to derive it from the conversation's model-provider
   * route profile (its `baseURL` with any `/v1/` suffix stripped).
   */
  baseURL: z.string().volatile(),
  /**
   * Credential reference holding the gateway API key. Omit to derive it from
   * the conversation's model-provider route profile (`apiKeyEnv`).
   */
  apiKeyEnv: z.string().role("credential-ref").volatile(),
  /** Single-request timeout; the gateway itself bounds upstream at 20s/account. */
  timeoutMs: z.number().step(1).min(1000).default(30000).volatile(),
  /** Default max_results when the request omits maxResults. */
  maxResults: z.number().step(1).min(1).max(20).default(5).volatile(),
  /** agenttool request type; the 0057 gateway pins "text2text" upstream. */
  type: z.string().default("text2text").volatile(),
  /** Only return results from these domains (agenttool allowed_domains). */
  allowedDomains: z.array(z.string()).volatile(),
  /** Exclude these domains; the gateway appends " -site:<domain>" to the query. */
  blockedDomains: z.array(z.string()).volatile(),
  /** Recency filter: d1 | m1 | y1. Omit to leave it unset. */
  freshness: z.union(FRESHNESS_VALUES.map((value) => z.const(value))).volatile(),
  /**
   * Register the plugin-owned `web_search` tool with model-visible filter
   * parameters. Requires `tool-web.search: false` in every preset. Default
   * false = keep the official `@deepseek-ai/dsh-tool-web` tool.
   */
  modelControlled: z.boolean().default(false).volatile(),
  /** Max queries accepted by one plugin-owned `web_search` call. */
  modelMaxQueries: z.number().step(1).min(1).max(10).default(10).volatile(),
  /** Per-source summary cap for the plugin-owned tool output. */
  modelSummaryMaxChars: z.number().step(1).min(100).default(800).volatile(),
});

/** Sole configured `llm-pi-ai` route id, or undefined when zero or multiple exist. */
function solePiAiRoute(ctx) {
  const llm = ctx.get("llm");
  if (llm === undefined) return undefined;
  const piAi = llm.listConfigurableProviders().filter((row) => row.settingsNs === "llm-pi-ai");
  return piAi.length === 1 ? piAi[0].provider : undefined;
}

/**
 * The model provider route of the conversation this search serves.
 * Falls back to the sole configured `llm-pi-ai` route when there is no initiating
 * session (headless / direct calls) or the session uses a non-pi-ai route.
 */
function conversationRoute(ctx) {
  const llm = ctx.get("llm");
  if (llm === undefined) return undefined;
  const fromSession = ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider;
  if (fromSession !== undefined && routeProfile(ctx, fromSession) !== undefined) return fromSession;
  return solePiAiRoute(ctx) ?? fromSession;
}

/**
 * Read the pi-ai provider profile for one route: the official
 * `dsh-web-deepseek-api` mechanism (listConfigurableProviders → loader
 * entries → effective config), generalized to any `llm-pi-ai` route by
 * walking the directory entry's `settingsPath`.
 * @returns the profile object, or undefined when the route is not a
 *   pi-ai route or its settings section is not mounted.
 */
function routeProfile(ctx, provider) {
  const llm = ctx.get("llm");
  const loader = ctx.get("loader");
  if (llm === undefined || loader === undefined) return undefined;
  if (!llm.listProviders().some((row) => row.id === provider)) return undefined;
  const directory = llm.listConfigurableProviders().find((row) => row.provider === provider);
  if (directory === undefined || directory.settingsNs !== "llm-pi-ai") return undefined;
  const entry = [...loader.entries()].find(
    (row) => row.options.id === directory.settingsNs && row.options.name === PI_AI_PACKAGE,
  );
  if (entry?.fiber?.state !== 2) return undefined;
  let node = entry.fiber.effectiveConfig;
  for (const key of directory.settingsPath) node = node?.[key];
  return node;
}

/** Strip a chat-route `/v1/` suffix so search posts to the same origin. */
function originOf(baseURL) {
  return baseURL.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

/**
 * Resolve one operation's endpoint + credential. Explicit config wins;
 * otherwise both derive from the conversation's model-provider route profile.
 * @returns {Promise<{baseURL: string, apiKey: string}>}
 * @throws {WebError} WEB_PROVIDER_CREDENTIAL_MISSING / WEB_PROVIDER_CONFIGURED_MISSING
 */
async function resolveTarget(ctx, options, signal) {
  let { baseURL, apiKeyEnv } = options;

  if (baseURL === undefined || apiKeyEnv === undefined) {
    const route = conversationRoute(ctx);
    const profile = route !== undefined ? routeProfile(ctx, route) : undefined;
    if (profile === undefined && apiKeyEnv === undefined) {
      throw new WebError(
        `web-search-workbuddy has no baseURL/apiKeyEnv configured and cannot derive them: ` +
        `no pi-ai model-provider route is resolvable for this conversation ` +
        `(route: ${String(route)}). Set web-search-workbuddy.baseURL and .apiKeyEnv explicitly.`,
        "WEB_PROVIDER_CONFIGURED_MISSING",
      );
    }
    if (apiKeyEnv === undefined) apiKeyEnv = profile?.apiKeyEnv;
    if (baseURL === undefined) {
      if (typeof profile?.baseURL === "string" && profile.baseURL.length > 0) {
        baseURL = originOf(profile.baseURL);
      } else {
        baseURL = DEFAULT_BASE_URL;
      }
    }
  }

  if (baseURL === undefined || !URL.canParse(baseURL)) {
    throw new WebError(
      `web-search-workbuddy has no usable baseURL (configured or derived: ${String(baseURL)}). ` +
      `Set web-search-workbuddy.baseURL to the workbuddy-manager origin.`,
      "WEB_PROVIDER_CONFIGURED_MISSING",
    );
  }
  baseURL = baseURL.replace(/\/+$/, "");

  if (apiKeyEnv === undefined) {
    throw new WebError(
      `web-search-workbuddy could not derive an apiKeyEnv: the conversation's model route ` +
      `profile names no credential reference. Set web-search-workbuddy.apiKeyEnv explicitly.`,
      "WEB_PROVIDER_CONFIGURED_MISSING",
    );
  }

  const credentials = ctx.get("credentials");
  const ref = credentialRef(apiKeyEnv);
  let apiKey;
  if (credentials !== undefined) {
    const value = (await credentials.resolve(ref))?.value;
    if (value !== undefined && value !== null && value.length > 0) apiKey = value;
  }
  if (apiKey === undefined || apiKey.length === 0) {
    const ambient = process.env[apiKeyEnv];
    if (ambient !== undefined && ambient.length > 0) apiKey = ambient;
  }
  if (apiKey === undefined || apiKey.length === 0) {
    throw new WebError(
      `WorkBuddy gateway search has no API key for "${apiKeyEnv}": the model route's credential ` +
      `reference resolves nothing for search. Store it through the credentials service or export it ` +
      `in the launching environment.`,
      "WEB_PROVIDER_CREDENTIAL_MISSING",
    );
  }
  if (signal?.aborted === true) {
    throw new WebError("WorkBuddy gateway search aborted", "WEB_ABORTED", { cause: signal.reason });
  }
  return { baseURL, apiKey };
}

/**
 * Whether a search for a model request has an endpoint + credential to send.
 * Presence only: no network calls, no secret value read beyond existence.
 */
async function searchConfigured(ctx, options, llmProvider) {
  if (options.apiKeyEnv !== undefined) return true;
  const preferred = llmProvider !== undefined ? routeProfile(ctx, llmProvider) : undefined;
  const fallbackRoute = preferred === undefined ? conversationRoute(ctx) : undefined;
  const profile = preferred ?? (fallbackRoute !== undefined ? routeProfile(ctx, fallbackRoute) : undefined);
  if (profile === undefined) return false;
  const hasKey =
    (typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv.length > 0) ||
    process.env[profile.apiKeyEnv ?? ""] !== undefined;
  return hasKey;
}

/** First defined value among the per-request overrides and the config default. */
function pick(...values) {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

/**
 * Normalize an agenttool domain list: trim, strip scheme/path, drop blanks and
 * case-insensitive duplicates. The gateway appends these to `-site:` (blocked)
 * or forwards them as-is (allowed), so bare hostnames are required on the wire.
 */
function cleanDomains(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    let domain = raw.trim();
    if (domain.length === 0) continue;
    domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const cut = domain.search(/[/?#]/);
    if (cut >= 0) domain = domain.slice(0, cut);
    domain = domain.replace(/^\./, "");
    if (domain.length === 0) continue;
    const key = domain.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(domain);
  }
  return out;
}

/** Clamp max_results into the 0057 gateway's 1..20 bound. */
function clampMaxResults(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_RESULTS_CAP, Math.max(1, Math.trunc(n)));
}

/**
 * Model-facing `web_search` arguments when `modelControlled` is enabled.
 * `queries` is the official shape; the rest are extras this plugin forwards
 * into `ctx.web.search()`'s request object (which the seam passes through).
 */
const MODEL_PARAMETERS = {
  type: "object",
  properties: {
    queries: {
      type: "array",
      items: { type: "string" },
      description: "1–10 search queries; their results are merged.",
    },
    allowedDomains: {
      type: "array",
      items: { type: "string" },
      description: "Only return results from these domains (e.g. [\"go.dev\"]).",
    },
    blockedDomains: {
      type: "array",
      items: { type: "string" },
      description: "Exclude these domains (e.g. [\"reddit.com\"]).",
    },
    freshness: {
      type: "string",
      enum: ["d1", "m1", "y1"],
      description: "Recency filter: d1 = past day, m1 = past month, y1 = past year.",
    },
    maxResults: {
      type: "integer",
      description: "Upper bound on sources returned (1..20). Defaults to the plugin config.",
    },
  },
  required: ["queries"],
  additionalProperties: false,
};

/** The canonical `web_search` output schema (same shape as the official tool). */
const MODEL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    content: { type: "string" },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          snippet: { type: "string" },
          summary: { type: "string" },
          publishedAt: { type: "string" },
        },
        required: ["url"],
      },
    },
    truncated: { type: "boolean" },
  },
  required: ["sources", "truncated"],
};

/** Collapse whitespace and cap one source summary, like the official tool. */
function boundSummary(summary, cap) {
  const text = String(summary ?? "").replace(/\s+/gu, " ").trim();
  if (text.length === 0) return undefined;
  return text.length <= cap ? text : `${text.slice(0, Math.max(0, cap - 1))}…`;
}

/** Project one seam source into the model-facing (lossless JSON) shape. */
function modelSource(source, cap) {
  const summary = boundSummary(source.summary, cap);
  const snippet = typeof source.snippet === "string" ? source.snippet.slice(0, 200) : undefined;
  return {
    url: source.url,
    ...(source.title !== undefined ? { title: source.title } : {}),
    ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {}),
  };
}

/** Merge per-query seam results round-robin, dedupe by URL, cap at maxResults. */
function mergeModelResults(queries, results, maxResults) {
  const seen = new Set();
  const sources = [];
  let ranks = 0;
  for (const result of results) ranks = Math.max(ranks, result.sources.length);
  let dropped = false;
  merge: for (let rank = 0; rank < ranks; rank++) {
    for (const result of results) {
      const source = result.sources[rank];
      if (source === undefined || seen.has(source.url)) continue;
      seen.add(source.url);
      if (sources.length === maxResults) { dropped = true; break merge; }
      sources.push(source);
    }
  }
  const contents = results.flatMap((result, index) =>
    result.content !== undefined && result.content.length > 0
      ? [`### ${queries[index]}\n\n${result.content}`] : []);
  return {
    ...(contents.length > 0 ? { content: contents.join("\n\n") } : {}),
    sources,
    truncated: results.some((result) => result.truncated) || dropped,
  };
}

/** Self-contained fallback when the official renderer helpers are unavailable. */
function fallbackFormatSearchOutput(result) {
  const parts = ["External web content follows."];
  if (result.content !== undefined && result.content.length > 0) parts.push(result.content);
  const sources = Array.isArray(result.sources) ? result.sources : [];
  if (sources.length > 0) {
    const lines = sources.map((source) => {
      let label = typeof source.title === "string" && source.title.length > 0 ? source.title : undefined;
      if (label === undefined) {
        try { label = new URL(source.url).hostname; } catch { label = source.url; }
      }
      const excerpt = typeof source.summary === "string" && source.summary.length > 0
        ? source.summary : (typeof source.snippet === "string" ? source.snippet : undefined);
      const meta = [
        ...(excerpt !== undefined && excerpt.length > 0 ? [excerpt] : []),
        ...(typeof source.publishedAt === "string" && source.publishedAt.length > 0 ? [`(${source.publishedAt})`] : []),
      ];
      return `- [${label}](${source.url})${meta.length > 0 ? ` — ${meta.join(" ")}` : ""}`;
    });
    parts.push(`Sources:\n${lines.join("\n")}`);
  } else if (result.content === undefined || result.content.length === 0) {
    parts.push("No results found.");
  }
  if (result.truncated) parts.push(`(Showing the first ${sources.length} sources. Refine the query for more.)`);
  parts.push("Cite the relevant URLs above as markdown links in your answer.");
  return parts.join("\n\n");
}

/** Validate the plugin-owned tool's arguments; return an Error or undefined. */
function validateModelArgs(args, maxQueries) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return new Error("web_search arguments must be an object");
  const a = args;
  if (!Array.isArray(a.queries)) return new Error("queries must be an array of strings");
  if (a.queries.length === 0) return new Error("queries must contain at least one query");
  if (a.queries.length > maxQueries) return new Error(`queries must contain at most ${maxQueries} queries`);
  if (a.queries.some((q) => typeof q !== "string" || q.trim().length === 0)) return new Error("each query must be a non-empty string");
  for (const key of ["allowedDomains", "blockedDomains"]) {
    if (a[key] !== undefined && (!Array.isArray(a[key]) || a[key].some((d) => typeof d !== "string"))) {
      return new Error(`${key} must be an array of strings`);
    }
  }
  if (a.freshness !== undefined && !FRESHNESS_VALUES.includes(a.freshness)) {
    return new Error(`freshness must be one of ${FRESHNESS_VALUES.join(", ")}`);
  }
  if (a.maxResults !== undefined && (!Number.isInteger(a.maxResults) || a.maxResults < 1 || a.maxResults > MAX_RESULTS_CAP)) {
    return new Error(`maxResults must be an integer in 1..${MAX_RESULTS_CAP}`);
  }
  return undefined;
}

/**
 * Replayable presentation meta for the plugin-owned tool, matching the
 * official `WebSearchMeta` shape (structured sources, truncation, answer).
 */
function modelSearchMeta(value) {
  const sources = (Array.isArray(value?.sources) ? value.sources : []).map((source) => ({
    url: source.url,
    ...(typeof source.title === "string" ? { title: source.title } : {}),
    ...(typeof source.snippet === "string" ? { snippet: source.snippet } : {}),
    ...(typeof source.publishedAt === "string" ? { publishedAt: source.publishedAt } : {}),
  }));
  return {
    sources,
    truncated: value?.truncated === true,
    ...(typeof value?.content === "string" ? { answer: value.content } : {}),
  };
}

/** Pending-call card: same generic search card as the official tool. */
function modelPresentCall(args) {
  const title = Array.isArray(args?.queries) ? args.queries.join(", ") : "";
  return { card: "generic", title, kind: "search", rawInput: title };
}

/** Completed-call card: same `card: "web"` citation list as the official tool. */
function modelPresentResult(args, result) {
  if (result.isError) return undefined;
  const meta = result.meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  if (!Array.isArray(meta.sources) || typeof meta.truncated !== "boolean") return undefined;
  return {
    card: "web",
    kind: "search",
    title: Array.isArray(args?.queries) ? args.queries.join(", ") : "",
    sources: meta.sources,
    truncated: meta.truncated,
    ...(typeof meta.answer === "string" ? { answer: meta.answer } : {}),
  };
}

/**
 * Register the model-facing `web_search` tool exposing the four optional
 * WorkBuddy filter parameters (`allowedDomains`, `blockedDomains`, `freshness`,
 * `maxResults`) alongside `queries`.
 *
 * Registers both:
 * 1. Globally when no global `web_search` is already registered (headless /
 *    non-agent / `tool-web.search: false` setups).
 * 2. In every live & newly-created Agent's own scope (`agent.ctx`) via
 *    `agent/created`, so the 5-parameter tool cleanly shadows preset-scoped
 *    `@deepseek-ai/dsh-tool-web` (e.g. `preset-standard`, `preset-ptc`,
 *    `preset-cordis`) and root `tool-web` without duplicate-registration errors
 *    or patching every agent preset.
 *
 * Registration is deferred through `ctx.inject(['tools', 'systemPrompt'], …)`
 * so the plugin does not require those services when `modelControlled` is off.
 */
function registerModelTool(ctx, config) {
  ctx.inject(["tools", "systemPrompt"], (child) => {
    const tools = child.get("tools");
    const systemPrompt = child.get("systemPrompt");
    if (tools === undefined || systemPrompt === undefined) return;
    const o = {
      modelMaxQueries: config.modelMaxQueries.get(),
      modelSummaryMaxChars: config.modelSummaryMaxChars.get(),
      maxResults: config.maxResults.get(),
      timeoutMs: config.timeoutMs.get(),
    };

    const toolDef = {
      name: "web_search",
      description: "Search the web for current information. Optionally restrict domains, exclude sites, filter by recency, and cap the number of sources.",
      parameters: MODEL_PARAMETERS,
      output: {
        schema: MODEL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: "text", text: fallbackFormatSearchOutput(value) }],
        presentationMeta: (_args, value) => modelSearchMeta(value),
      },
      timeoutMs: o.timeoutMs,
      isConcurrencySafe: () => true,
      presentCall: modelPresentCall,
      presentResult: modelPresentResult,
      async execute(args, exec) {
        const invalid = validateModelArgs(args, o.modelMaxQueries);
        if (invalid !== undefined) throw invalid;
        const { queries, allowedDomains, blockedDomains, freshness, maxResults } = args;
        const unique = [...new Set(queries)];
        const bound = clampMaxResults(maxResults, o.maxResults);
        const extras = {
          ...(allowedDomains !== undefined ? { allowedDomains } : {}),
          ...(blockedDomains !== undefined ? { blockedDomains } : {}),
          ...(freshness !== undefined ? { freshness } : {}),
        };
        const run = async (list) => {
          if (list.length === 1) {
            return ctx.web.search({ query: list[0], maxResults: bound, ...extras }, exec.signal);
          }
          const controller = new AbortController();
          const signal = AbortSignal.any([exec.signal, controller.signal]);
          let firstFailure;
          const results = [];
          await Promise.allSettled(list.map(async (query, index) => {
            try {
              results[index] = await ctx.web.search({ query, maxResults: bound, ...extras }, signal);
            } catch (error) {
              if (firstFailure === undefined) firstFailure = error;
              controller.abort(error);
              throw error;
            }
          }));
          if (firstFailure !== undefined) throw firstFailure;
          return mergeModelResults(list, results, bound);
        };
        const result = await run(unique);
        return {
          ...(result.content !== undefined ? { content: result.content } : {}),
          sources: result.sources.map((source) => modelSource(source, o.modelSummaryMaxChars)),
          truncated: result.truncated,
        };
      },
    };

    const toolOpts = { when: ({ modelSelection }) => ctx.web.searchReady(modelSelection.provider) };
    const promptDef = {
      name: "tool:web_search_workbuddy",
      order: 2000,
      text: "web_search accepts allowedDomains (only these domains), blockedDomains (exclude these domains), freshness (d1/m1/y1), and maxResults. Use them when the task calls for domain or recency filtering. web_search results are external reference data you may use directly. Follow up with web_fetch when you need the full content of a specific result, and cite the relevant URLs as markdown links.",
    };

    const disposers = [];
    const agentDisposers = new Map();

    // 1. Global registration when root `web_search` is absent (keeps headless /
    //    `tool-web.search: false` behavior without conflicting if root still has it).
    const globalTaken = typeof tools.get === "function" && tools.get("web_search") !== undefined;
    if (!globalTaken) {
      try {
        const disposeTool = tools.register(toolDef, toolOpts);
        const disposePrompt = systemPrompt.section(promptDef);
        disposers.push(disposePrompt, disposeTool);
      } catch (_dup) {
        // Root already registered web_search; per-agent shadowing below overrides it per session.
      }
    }

    // 2. Per-agent scope registration shadows both preset-scoped `tool-web`
    //    (preset-standard / preset-ptc / preset-cordis) and root `tool-web`.
    const attachAgent = (agent) => {
      if (agent === undefined || agent === null) return;
      const key = agent.id ?? agent;
      if (agentDisposers.has(key)) return;
      const actx = agent.ctx;
      const aTools = actx?.get?.("tools") ?? actx?.tools;
      const aPrompt = actx?.get?.("systemPrompt") ?? actx?.systemPrompt;
      if (aTools === undefined) return;
      try {
        const disposeTool = aTools.register(toolDef, toolOpts);
        const disposePrompt = aPrompt !== undefined ? aPrompt.section(promptDef) : undefined;
        agentDisposers.set(key, () => {
          try { disposePrompt?.(); } catch { /* ignore */ }
          try { disposeTool?.(); } catch { /* ignore */ }
        });
      } catch (_err) {
        // Agent already disposed or tool already registered in this agent scope.
      }
    };

    if (typeof child.on === "function") {
      const offCreated = child.on("agent/created", (payload) => { attachAgent(payload?.agent); });
      if (typeof offCreated === "function") disposers.push(offCreated);
      const offDisposed = child.on("agent/disposed", (payload) => {
        const key = payload?.agent?.id ?? payload?.agent;
        if (key !== undefined) agentDisposers.delete(key);
      });
      if (typeof offDisposed === "function") disposers.push(offDisposed);
    }

    const existingAgents = child.get("agents")?.list?.();
    if (Array.isArray(existingAgents)) {
      for (const agent of existingAgents) attachAgent(agent);
    }

    return () => {
      for (const dispose of agentDisposers.values()) dispose();
      agentDisposers.clear();
      for (let i = disposers.length - 1; i >= 0; i--) {
        try { disposers[i](); } catch { /* ignore */ }
      }
    };
  });
}

/**
 * Build the complete `/v1/tools/search` body — every parameter the upstream
 * agenttool endpoint supports. Per-request overrides win over config defaults;
 * empty optional values are omitted so the gateway keeps its own defaults.
 *
 * @throws {WebError} WEB_PROVIDER_ERROR on an invalid freshness value.
 */
function buildSearchBody(request, options) {
  const body = { query: request.query };

  body.type = String(pick(request.type, options.type, "text2text"));
  body.max_results = clampMaxResults(
    pick(request.maxResults, request.max_results, options.maxResults),
    options.maxResults,
  );

  const allowed = cleanDomains(pick(request.allowedDomains, request.allowed_domains, options.allowedDomains));
  if (allowed.length > 0) body.allowed_domains = allowed;

  const blocked = cleanDomains(pick(request.blockedDomains, request.blocked_domains, options.blockedDomains));
  if (blocked.length > 0) body.blocked_domains = blocked;

  const freshness = pick(request.freshness, options.freshness);
  if (freshness !== undefined && String(freshness).length > 0) {
    const value = String(freshness);
    if (!FRESHNESS_VALUES.includes(value)) {
      throw new WebError(
        `WorkBuddy search freshness must be one of ${FRESHNESS_VALUES.join(", ")} (got ${JSON.stringify(value)})`,
        "WEB_PROVIDER_ERROR",
      );
    }
    body.freshness = value;
  }
  return body;
}

/** Map the agenttool envelope to the seam's normalized result. */
function mapResponse(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const sources = [];
  const seen = new Set();
  for (const item of results) {
    const url = String(item?.url ?? "");
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    const snippet = String(item?.snippet ?? "");
    sources.push({
      url,
      ...(item?.title != null && item.title.length > 0 ? { title: String(item.title) } : {}),
      ...(snippet.length > 0
        ? { snippet: snippet.slice(0, 200), summary: snippet.slice(0, 1200) }
        : {}),
    });
  }
  return { sources, truncated: false };
}

/** One search against the gateway. Honors `signal` and `timeoutMs`. */
async function search(ctx, options, request, signal) {
  const { baseURL, apiKey } = await resolveTarget(ctx, options, signal);
  const body = buildSearchBody(request, options);
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 30000);
  const combinedSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response;
  try {
    response = await fetch(`${baseURL}/v1/tools/search`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (error) {
    if (signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError")) {
      throw new WebError("WorkBuddy gateway search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
    }
    if (timeoutSignal.aborted) {
      throw new WebError(
        `WorkBuddy gateway search timed out after ${options.timeoutMs}ms`,
        "WEB_PROVIDER_ERROR",
        { cause: error },
      );
    }
    throw new WebError(
      `WorkBuddy gateway search request failed: ${String(error)}\n\nThe web request used endpoint ${JSON.stringify(`${baseURL}/v1/tools/search`)}. Check that workbuddy-manager (with the /v1/tools/search passthrough) is running and reachable.`,
      "WEB_PROVIDER_ERROR",
      { cause: error },
    );
  }

  if (!response.ok) {
    let detail = "";
    let quotaExhausted = false;
    try {
      const parsed = await response.json();
      detail = typeof parsed?.error === "string" ? parsed.error : (parsed?.error?.message ?? parsed?.msg ?? "");
      quotaExhausted = parsed?.code === "quota_web_search";
    } catch (_unparseable) {
      // keep empty detail
    }
    if (quotaExhausted) {
      throw new WebError(
        `WorkBuddy web search quota exhausted on all pool accounts (upstream 15001); quota resets daily`,
        "WEB_PROVIDER_ERROR",
      );
    }
    throw new WebError(
      `WorkBuddy gateway search failed (HTTP ${response.status})${detail.length > 0 ? `: ${detail}` : ""}\n\nThe web request used endpoint ${JSON.stringify(`${baseURL}/v1/tools/search`)}.`,
      "WEB_PROVIDER_ERROR",
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (signal?.aborted === true) throw new WebError("WorkBuddy gateway search aborted", "WEB_ABORTED", { cause: signal.reason });
    if (timeoutSignal.aborted) {
      throw new WebError(`WorkBuddy gateway search timed out after ${options.timeoutMs}ms`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    throw new WebError(`WorkBuddy gateway returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
  }

  // agenttool business envelope: code != 0 is an upstream business failure
  // even on HTTP 200 (the gateway passes non-15001 codes through verbatim).
  if (data?.code !== undefined && data.code !== 0) {
    throw new WebError(
      `WorkBuddy search upstream code ${data.code}: ${data.msg ?? ""}`,
      "WEB_PROVIDER_ERROR",
    );
  }

  return mapResponse(data);
}

/**
 * Register the gateway-backed search provider with ctx.web. Endpoint and
 * credential default to the conversation's own model-provider route; `ready()`
 * answers presence (the tool uses it to admit `web_search` into a request).
 * When `modelControlled` is on, also register the plugin-owned model-facing
 * `web_search` tool (official `tool-web.search` must be disabled).
 */
function apply(ctx, config) {
  const options = () => ({
    baseURL: config.baseURL.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    timeoutMs: config.timeoutMs.get(),
    maxResults: config.maxResults.get(),
    type: config.type.get(),
    allowedDomains: config.allowedDomains.get(),
    blockedDomains: config.blockedDomains.get(),
    freshness: config.freshness.get(),
  });

  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => true,
    ready: (llmProvider) => searchConfigured(ctx, options(), llmProvider),
    search: (request, signal) => search(ctx, options(), request, signal),
  });

  if (config.modelControlled.get() === true) registerModelTool(ctx, config);
}

export { Config, PROVIDER_ID, apply, inject, name };
