/**
 * dsh-web-search-workbuddy — WorkBuddy gateway-backed search provider
 * for the DSH web capability seam. See README.md and lib/index.js.
 */
export interface WebSearchWorkBuddyConfig {
  /** Gateway base (manager reverse-proxy or the wb2api-go port directly). */
  baseURL: string;
  /** Credential reference holding the gateway API key. */
  apiKeyEnv: string;
  /** Single-request timeout in ms. */
  timeoutMs: number;
  /** Default max_results when the search request omits maxResults. */
  maxResults: number;
}
/** Stable provider id this plugin registers under. */
export declare const PROVIDER_ID: "workbuddy-gateway";
/** Cordis plugin name used by loader diagnostics. */
export declare const name: "web-search-workbuddy";
/** The web seam this provider registers into. */
export declare const inject: readonly ["web"];
