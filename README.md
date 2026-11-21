# dsh-web-search-workbuddy

WorkBuddy gateway-backed search provider for the DeepSeek Harness web capability
seam (`ctx.web`). Bridges the model-facing `web_search` tool to the
workbuddy2api-go gateway's agenttool web-search passthrough, with
[workbuddy-manager](https://github.com/WaveBird/workbuddy-manager) as the
entry proxy — so **one `wbk_` key serves both the chat route and `web_search`**.

**v0.4.1**: optionally owns the model-facing `web_search` tool so the model
itself can choose `allowedDomains` / `blockedDomains` / `freshness` /
`maxResults` per call — without patching the official `dsh-tool-web` package.
Original provider-only mode (v0.4.0) remains the default.

**v0.4.0**: forwards every parameter `workbuddy.cn/agenttool/v1/search`
supports (`type`, `max_results`, `allowed_domains`, `blocked_domains`,
`freshness`) — see [Protocol](#protocol).

```
DSH session ── ctx.web.search() ──▶ this provider
                                       │  POST {manager}:7864/v1/tools/search   (wbk_ key)
                                       ▼
                              workbuddy-manager  (auth + upstream resolve + logging)
                                       │  POST {wb2api-go}:7863/v1/tools/search
                                       ▼
                              wb2api-go  (account-pool rotation + 15001 quota cooldown)
                                       ▼
                              https://www.workbuddy.cn/agenttool/v1/search
```

## ⚠️ Compatibility requirements（兼容性要求）

This plugin is **not standalone**. It depends on a specific feature set that
landed in the WorkBuddy ecosystem at pinned versions; running against an
unpatched stack fails with `404` (route missing) or `401` (search endpoint
expecting the gateway key):

| Component | Required version / state | Why |
|---|---|---|
| **workbuddy-manager** | **≥ the `feat/web-search-passthrough` branch** ([PR #2](https://github.com/WaveBird/workbuddy-manager/pull/2), upstream [PR #430](https://github.com/ithtelab/workbuddy-manager/pull/430)). Baseline tested: `v2.11.14` + the PR's 3 commits (`dce9acc` route, `5e88629` realm fix, `c33e122` docs). For the v0.4.0 full-parameter set also take the small API follow-up: `/v1/tools/search` validates `type`/`max_results`/`allowed_domains`/`blocked_domains`/`freshness` and forwards the body verbatim. It will ship in a release **after v2.11.14** — until then, deploy the branch or cherry-pick. | The `POST /v1/tools/search` passthrough route **does not exist** in upstream releases ≤ v2.11.14. Older managers return `405` and this provider cannot work through them. |
| **workbuddy2api-go gateway** | Built from the upstream snapshot **`upstream-id 801cebba` (v2.11.14 / 0056 patches)** plus [`0057-web-search-tool.patch`](https://github.com/WaveBird/workbuddy-manager/blob/feat/web-search-passthrough/dev/upstream-patches/0057-web-search-tool.patch) (shipped inside the manager PR above). | The `POST /v1/tools/search` handler, account-pool rotation, and 15001 quota cooldown live in this patch; the stock gateway has no agenttool route. |
| **DeepSeek Harness (DSH)** | `>=0.2.2-rc.1 <0.3.0-0` (web seam contract `ctx.web.registerSearchProvider` / `WebSearchProvider` shape). Verified against `0.2.2-rc.1` through `0.2.2-rc.5`; any `0.2.x` version keeping that seam shape works. | The provider registers into `ctx.web`; a breaking seam change (e.g. `0.3.x`) would require a plugin update. |
| **Realm coverage (CN + Global)** | Both realms supported. The gateway routes agenttool by account realm (CN → `www.workbuddy.cn`, Global → `www.workbuddy.ai`, both endpoints probe-verified) — a `global:`-realm key (WorkBuddy AI / international) searches the same way as CN. The plugin itself is realm-agnostic: it follows whatever model route the conversation uses. | International accounts participate in the same account-pool rotation and 15001 quota cooldown as CN. |

Quick self-check per component:

```bash
# manager: route exists and accepts the wbk_ key (405/401 → wrong manager version);
# full-parameter body must be forwarded verbatim (200; 400 invalid_search_params → old route)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:7864/v1/tools/search \
  -H "Authorization: Bearer <wbk_ key>" -H 'content-type: application/json' \
  -d '{"query":"ping","type":"text2text","max_results":3,"allowed_domains":["go.dev"],"blocked_domains":["reddit.com"],"freshness":"d1"}'

# gateway (bypassing manager): 401 with the gateway's own api_key configured means alive
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:7863/v1/tools/search \
  -H 'content-type: application/json' -d '{"query":"ping"}'
```

## Install

```bash
# Recommended: via the DSH plugin CLI (pass --profile <name> if not using the default profile):
dsh plugin add dsh-web-search-workbuddy
# e.g. for the `web` profile:
dsh plugin --profile web add dsh-web-search-workbuddy

# Or directly via pnpm / npm:
cd ~/.dsh/profiles/web && pnpm add dsh-web-search-workbuddy
npm install dsh-web-search-workbuddy
```

Peer dependencies (`@deepseek-ai/dsh-web`, `@deepseek-ai/dsh-credentials`,
`@deepseek-ai/cordis`) resolve from the DSH profile's own `node_modules` when
installed this way; `@deepseek-ai/schemastery` ships as a direct dependency.

## DSH profile assembly

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: web-search-workbuddy
      name: dsh-web-search-workbuddy
      # No config needed: baseURL + apiKeyEnv derive from the conversation's
      # model-provider route automatically. Optional search defaults (v0.4.0):
      # config:
      #   type: text2text              # agenttool 请求类型（固定）
      #   maxResults: 5                # 1..20；请求级 maxResults 优先
      #   allowedDomains: [go.dev]     # 只返回这些域
      #   blockedDomains: [reddit.com] # 网关拼成 " -site:reddit.com"
      #   freshness: d1                # d1 | m1 | y1
      #   modelControlled: true        # v0.4.1：模型自主控制过滤参数
      #   modelMaxQueries: 10          # 一次调用最多几条 query
      #   modelSummaryMaxChars: 800    # 每条来源摘要上限
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    fetchProvider: http
    searchProvider: workbuddy-gateway           # ← pin this provider
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  # Default mode (modelControlled: false): keep search: true in EVERY preset.
  config: { fetch: true, search: true, searchTimeoutMs: 60000 }
# also set search: true in every agent preset's tool-web entry
```

### Model-controlled mode (v0.4.1)

With `modelControlled: true`, this plugin registers a replacement `web_search`
tool whose schema exposes:

```json
{
  "queries": ["go generics"],
  "allowedDomains": ["go.dev"],
  "blockedDomains": ["reddit.com"],
  "freshness": "d1",
  "maxResults": 5
}
```

The tool forwards those extras into `ctx.web.search()`'s request object; the
seam passes it through unchanged and the provider maps them onto the gateway
body (request values win over the config defaults above). No DSH framework
file is modified. Because `ctx.tools.register()` rejects duplicate names,
assembly **must** set `search: false` on every `@deepseek-ai/dsh-tool-web`
entry (the global one and all agent presets); `web_fetch` stays enabled:

```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config: { fetch: true, search: false, searchTimeoutMs: 60000 }
```

If any preset still has `search: true`, startup reports a duplicate
`web_search`; either disable it or set `modelControlled: false` to keep the
official tool. A system-prompt section teaches the model when to use the four
optional filters.

Fully restart `dsh web` afterwards (patch changes do not HMR). The model's tool
catalog gains the extended `web_search` in new sessions.

### Zero-config credential derivation

With no explicit config, the plugin reads the **model provider route the
conversation is already using** (e.g. `workbuddy-mannager-cn` registered under
`llm-pi-ai`): its `apiKeyEnv` credential reference is resolved for the search
request, and its `baseURL` minus the `/v1/` suffix becomes the search origin —
the search endpoint lives on the same manager host (`/v1/tools/search` beside
`/v1/chat/completions`). Same mechanism as the official
`@deepseek-ai/dsh-web-deepseek-api` (`listConfigurableProviders` → loader
entries → effective config).

Explicit `baseURL` / `apiKeyEnv` still win when set — for deployments whose
search endpoint differs from the chat route, or whose model key cannot reach
the search route.

## Protocol

```json
POST {baseURL}/v1/tools/search
Authorization: Bearer <wbk_ key>
{
  "query": "...",
  "type": "text2text",
  "max_results": 5,
  "allowed_domains": ["go.dev"],
  "blocked_domains": ["reddit.com"],
  "freshness": "d1"
}
```

Every parameter the upstream `workbuddy.cn/agenttool/v1/search` accepts is
covered. The manager route validates the known optional fields and forwards
the body verbatim; the 0057 gateway pins `type`, applies `max_results`,
passes `allowed_domains`/`freshness` upstream and appends `-site:<domain>`
for `blocked_domains` (official CLI semantics).

| agenttool parameter | Plugin config key | Values / default |
|---|---|---|
| `query` | (from the seam request) | required |
| `type` | `type` | `"text2text"` (default) |
| `max_results` | `maxResults` | 1..20, default `5`; seam request `maxResults` wins |
| `allowed_domains` | `allowedDomains` | string[]; scheme/path stripped, deduped; empty = omitted |
| `blocked_domains` | `blockedDomains` | string[]; same normalization; empty = omitted |
| `freshness` | `freshness` | `d1` \| `m1` \| `y1`; unset = omitted |

The DSH web seam's `WebSearchRequest` carries only `query` + `maxResults` in
its type, but `ctx.web.search()` passes the request object through untouched.
In default mode (v0.4.0) the other four parameters are deployment-level
defaults in this plugin's config. In `modelControlled: true` mode (v0.4.1) the
plugin-owned tool exposes them to the model per call. For direct callers each
one also accepts a **per-request override**, in camelCase or the upstream
snake_case spelling — `type`, `maxResults`/`max_results`,
`allowedDomains`/`allowed_domains`, `blockedDomains`/`blocked_domains`,
`freshness`. Request overrides win over config; invalid `freshness` fails
locally as `WEB_PROVIDER_ERROR` without spending an account-pool search quota.
Empty optional values are omitted from the wire body.

Response is the upstream agenttool envelope passed through verbatim:

```json
{ "code": 0, "msg": "", "results": [{ "title": "...", "url": "...", "snippet": "..." }],
  "total_results": 3, "response_time_ms": 616, "provider": "1" }
```

This provider maps it to the seam's normalized result (`{url,title,snippet,summary}`
sources; url-scheme filter + dedupe; `maxResults` truncation owned by the seam).

## Error vocabulary

| Situation | WebError code |
|---|---|
| No gateway key configured | `WEB_PROVIDER_CREDENTIAL_MISSING` |
| Manager unreachable / non-2xx / upstream business code ≠ 0 | `WEB_PROVIDER_ERROR` |
| All-pool search quota exhausted (15001, gateway 429 `quota_web_search`) | `WEB_PROVIDER_ERROR` (message says quota) |
| Caller cancellation | `WEB_ABORTED` |
| `timeoutMs` elapsed | `WEB_PROVIDER_ERROR` (message says timed out) |
| Invalid per-request `freshness` | `WEB_PROVIDER_ERROR` (no request sent) |
| Invalid config (`freshness` / array / `maxResults` bounds) | rejected by the Config schema at assembly |

## License

MIT — see the upstream projects' licenses for their respective code.
