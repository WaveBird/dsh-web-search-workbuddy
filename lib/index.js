/**
 * dsh-web-search-workbuddy
 *
 * WorkBuddy gateway-backed search provider for the DSH web capability seam
 * (ctx.web). Bridges `ctx.web.search()` to the workbuddy2api-go gateway's
 * agenttool web-search passthrough endpoint (0057 patch):
 *
 *   POST {baseURL}/v1/tools/search
 *   body: {"query": "...", "max_results": 5, "blocked_domains": [...], "freshness": "d1|m1|y1"}
 *   resp: {"code":0, "results":[{title,url,snippet}], ...}   (agenttool envelope passthrough)
 *         or {"error":"...", "code":"quota_web_search", ...} on 429 (all-pool 15001)
 *
 * Provider id registers as "workbuddy-gateway"; pin it with
 * `web.searchProvider: workbuddy-gateway` in the profile patch.
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

const Config = z.object({
  /** Gateway base (manager reverse-proxy or the wb2api-go port directly). */
  baseURL: z.string().default("http://127.0.0.1:7864").volatile(),
  /** Credential reference holding the gateway API key. */
  apiKeyEnv: z.string().role("credential-ref").default("WORKBUDDY_MANNAGER_CN_API_KEY").volatile(),
  /** Single-request timeout; the gateway itself bounds upstream at 20s/account. */
  timeoutMs: z.number().step(1).min(1000).default(30000).volatile(),
  /** Default max_results when the request omits maxResults. */
  maxResults: z.number().step(1).min(1).max(20).default(5).volatile(),
});

/**
 * Resolve the gateway API key for one search: credentials service first,
 * launch environment fallback. Undefined when neither holds a value.
 */
async function resolveApiKey(ctx, options) {
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    const value = (await credentials.resolve(credentialRef(options.apiKeyEnv)))?.value;
    if (value !== undefined && value.length > 0) return value;
  }
  const ambient = process.env[options.apiKeyEnv];
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined;
}

/**
 * Whether a search for a model request has a gateway key to send. Presence
 * only: no network calls, no secret value read beyond existence.
 */
async function searchConfigured(ctx, options) {
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    try {
      const described = await credentials.describe(credentialRef(options.apiKeyEnv));
      if (described?.configured === true) return true;
    } catch (_unreadableStore) {
      // fall through to the environment check
    }
  }
  const ambient = process.env[options.apiKeyEnv];
  return ambient !== undefined && ambient.length > 0;
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
  const apiKey = await resolveApiKey(ctx, options);
  if (apiKey === undefined) {
    throw new WebError(
      `WorkBuddy gateway search has no API key for "${options.apiKeyEnv}"; store it through the credentials service or export it in the launching environment`,
      "WEB_PROVIDER_CREDENTIAL_MISSING",
    );
  }

  let response;
  try {
    response = await fetch(`${options.baseURL}/v1/tools/search`, {
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
      `WorkBuddy gateway search request failed: ${String(error)}\n\nThe web request used endpoint ${JSON.stringify(`${options.baseURL}/v1/tools/search`)}. Check that the workbuddy2api gateway (0057 patch build) is running and that web-search-workbuddy.baseURL points at it.`,
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
      `WorkBuddy gateway search failed (HTTP ${response.status})${detail.length > 0 ? `: ${detail}` : ""}\n\nThe web request used endpoint ${JSON.stringify(`${options.baseURL}/v1/tools/search`)}.`,
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
 * Register the gateway-backed search provider with ctx.web. `ready()` answers
 * whether a search has a gateway key configured (tool-web uses this to decide
 * whether the model step admits `web_search`).
 */
function apply(ctx, config) {
  const options = () => ({
    baseURL: config.baseURL.get().replace(/\/+$/, ""),
    apiKeyEnv: config.apiKeyEnv.get(),
    timeoutMs: config.timeoutMs.get(),
    maxResults: config.maxResults.get(),
  });

  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => URL.canParse(options().baseURL),
    ready: (async () => searchConfigured(ctx, options())),
    search: (request, signal) => search(ctx, options(), request, signal),
  });
}

export { Config, PROVIDER_ID, apply, inject, name };
