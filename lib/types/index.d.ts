/**
 * dsh-web-search-workbuddy — WorkBuddy gateway-backed search provider
 * for the DSH web capability seam. See README.md and lib/index.js.
 *
 * v0.4.0: full agenttool/v1/search parameter set (type / max_results /
 * allowed_domains / blocked_domains / freshness).
 */
/** Recency filter accepted by agenttool/v1/search. */
export type WebSearchFreshness = 'd1' | 'm1' | 'y1';
export interface WebSearchWorkBuddyConfig {
  /** Gateway base (manager reverse-proxy or the wb2api-go port directly). */
  baseURL: string;
  /** Credential reference holding the gateway API key. */
  apiKeyEnv: string;
  /** Single-request timeout in ms. */
  timeoutMs: number;
  /** Default max_results when the search request omits maxResults (1..20). */
  maxResults: number;
  /** agenttool request type; fixed "text2text" upstream. Defaults to "text2text". */
  type: string;
  /** Only return results from these domains (agenttool allowed_domains). */
  allowedDomains: string[];
  /** Excluded domains; the 0057 gateway appends " -site:<domain>" to the query. */
  blockedDomains: string[];
  /** Recency filter; omitted = no freshness constraint. */
  freshness: WebSearchFreshness;
  /**
   * v0.4.1: register a plugin-owned `web_search` tool exposing the filter
   * parameters to the model. Requires `tool-web.search: false` in every preset.
   */
  modelControlled: boolean;
  /** Upper bound on queries in one plugin-owned `web_search` call. */
  modelMaxQueries: number;
  /** Per-source summary cap in the plugin-owned tool's output. */
  modelSummaryMaxChars: number;
}
/**
 * Optional per-request overrides accepted by the provider's `search()` in
 * addition to the seam's `query` / `maxResults`. camelCase and upstream
 * snake_case spellings are equivalent; request values win over config.
 */
export interface WebSearchWorkBuddyRequestOverrides {
  type?: string;
  max_results?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  freshness?: WebSearchFreshness | string;
}
/** Stable provider id this plugin registers under. */
export declare const PROVIDER_ID: "workbuddy-gateway";
/** Cordis plugin name used by loader diagnostics. */
export declare const name: "web-search-workbuddy";
/** The web seam this provider registers into. */
export declare const inject: readonly ["web"];
