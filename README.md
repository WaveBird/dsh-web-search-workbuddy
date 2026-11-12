# dsh-web-search-workbuddy

WorkBuddy gateway-backed search provider for the DeepSeek Harness web capability
seam (`ctx.web`). Bridges the model-facing `web_search` tool to the
workbuddy2api-go gateway's agenttool web-search passthrough, with
[workbuddy-manager](https://github.com/WaveBird/workbuddy-manager) as the
entry proxy — so **one `wbk_` key serves both the chat route and `web_search`**.

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
| **workbuddy-manager** | **≥ the `feat/web-search-passthrough` branch** ([PR #2](https://github.com/WaveBird/workbuddy-manager/pull/2)). Baseline tested: `v2.11.14` + the PR's 3 commits (`dce9acc` route, `5e88629` realm fix, `c33e122` docs). It will ship in a release **after v2.11.14** — until then, deploy the branch or cherry-pick. | The `POST /v1/tools/search` passthrough route **does not exist** in upstream releases ≤ v2.11.14. Older managers return `405` and this provider cannot work through them. |
| **workbuddy2api-go gateway** | Built from the upstream snapshot **`upstream-id 801cebba` (v2.11.14 / 0056 patches)** plus [`0057-web-search-tool.patch`](https://github.com/WaveBird/workbuddy-manager/blob/feat/web-search-passthrough/dev/upstream-patches/0057-web-search-tool.patch) (shipped inside the manager PR above). | The `POST /v1/tools/search` handler, account-pool rotation, and 15001 quota cooldown live in this patch; the stock gateway has no agenttool route. |
| **DeepSeek Harness (DSH)** | `0.2.2-rc.2` (web seam contract `ctx.web.registerSearchProvider` / `WebSearchProvider` shape). Tested against `0.2.2-rc.1` and `rc.2`; any version keeping that seam shape works. | The provider registers into `ctx.web`; a breaking seam change would require a plugin update. |

Quick self-check per component:

```bash
# manager: route exists and accepts the wbk_ key (405/401 → wrong manager version)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:7864/v1/tools/search \
  -H "Authorization: Bearer <wbk_ key>" -H 'content-type: application/json' \
  -d '{"query":"ping"}'

# gateway (bypassing manager): 401 with the gateway's own api_key configured means alive
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:7863/v1/tools/search \
  -H 'content-type: application/json' -d '{"query":"ping"}'
```

## Install

```bash
npm install dsh-web-search-workbuddy
# or inside the DSH profile (recommended):
cd ~/.dsh/profiles/web && pnpm add dsh-web-search-workbuddy
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
      # No baseURL / apiKeyEnv needed: both derive from the conversation's own
      # model-provider route (its apiKeyEnv credential + baseURL with /v1/ stripped).
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    fetchProvider: http
    searchProvider: workbuddy-gateway           # ← pin this provider
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config: { fetch: true, search: true, searchTimeoutMs: 60000 }
# also set search: true in every agent preset's tool-web entry
```

Fully restart `dsh web` afterwards (patch changes do not HMR). The model's tool
catalog gains `web_search` in new sessions.

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
{ "query": "...", "max_results": 5, "blocked_domains": [...], "freshness": "d1|m1|y1" }
```

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

## License

MIT — see the upstream projects' licenses for their respective code.
