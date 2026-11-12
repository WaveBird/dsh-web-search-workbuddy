/**
 * dsh-web-search-workbuddy
 *
 * WorkBuddy gateway-backed search provider for the DSH web capability seam
 * (ctx.web). Bridges `ctx.web.search()` to the workbuddy2api-go gateway's
 * agenttool web-search passthrough endpoint (0057 patch) **through
 * workbuddy-manager**:
 *
 *   POST {baseURL}/v1/tools/search
 *   body: {"query": "...", "max_results": 5, "blocked_domains": [...], "freshness": "d1|m1|y1"}
 *   resp: {"code":0, "results":[{title,url,snippet}], ...}   (agenttool envelope passthrough)
 *         or {"error":"...", "code":"quota_web_search", ...} on 429 (all-pool 15001)
 *
 * Provider id registers as "workbuddy-gateway"; pin it with
 * `web.searchProvider: workbuddy-gateway` in the profile patch.
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

/** The web seam this provider registers into. */
const inject = ["web"];

/** Loader package that owns the pi-ai provider profiles. */
const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

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
});

/**
 * The model provider route of the conversation this search serves.
 * Falls back to the sole configured route when there is no initiating
 * session (headless / direct calls) and exactly one exists.
 */
function conversationRoute(ctx) {
  const llm = ctx.get("llm");
  if (llm === undefined) return undefined;
  const fromSession = ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider;
  if (fromSession !== undefined) return fromSession;
  const configured = llm.listConfigurableProviders();
  return configured.length === 1 ? configured[0].provider : undefined;
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
    if (profile === undefined) {
      throw new WebError(
        `web-search-workbuddy has no baseURL/apiKeyEnv configured and cannot derive them: ` +
        `no pi-ai model-provider route is resolvable for this conversation ` +
        `(route: ${String(route)}). Set web-search-workbuddy.baseURL and .apiKeyEnv explicitly.`,
        "WEB_PROVIDER_CONFIGURED_MISSING",
      );
    }
    if (apiKeyEnv === undefined) apiKeyEnv = profile.apiKeyEnv;
    if (baseURL === undefined && typeof profile.baseURL === "string" && profile.baseURL.length > 0) {
      baseURL = originOf(profile.baseURL);
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
  if (options.baseURL !== undefined && options.apiKeyEnv !== undefined) return true;
  const route = llmProvider ?? conversationRoute(ctx);
  const profile = route !== undefined ? routeProfile(ctx, route) : undefined;
  if (profile === undefined) return false;
  const hasKey =
    (typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv.length > 0) ||
    process.env[profile.apiKeyEnv ?? ""] !== undefined;
  const hasURL =
    options.baseURL !== undefined ||
    (typeof profile.baseURL === "string" && profile.baseURL.length > 0);
  return hasKey && hasURL;
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

/** One search against the gateway. Honors `signal` for cancellation. */
async function search(ctx, options, request, signal) {
  const { baseURL, apiKey } = await resolveTarget(ctx, options, signal);

  let response;
  try {
    response = await fetch(`${baseURL}/v1/tools/search`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: request.query,
        max_results: request.maxResults ?? options.maxResults,
      }),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError")) {
      throw new WebError("WorkBuddy gateway search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
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
 * answers presence (tool-web uses it to admit `web_search` into a request).
 */
function apply(ctx, config) {
  const options = () => ({
    baseURL: config.baseURL.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    timeoutMs: config.timeoutMs.get(),
    maxResults: config.maxResults.get(),
  });

  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => true,
    ready: (llmProvider) => searchConfigured(ctx, options(), llmProvider),
    search: (request, signal) => search(ctx, options(), request, signal),
  });
}

export { Config, PROVIDER_ID, apply, inject, name };
