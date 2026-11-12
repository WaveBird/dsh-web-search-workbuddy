# dsh-web-search-workbuddy

WorkBuddy gateway-backed search provider for the DeepSeek Harness web capability
seam (`ctx.web`). Bridges the model-facing `web_search` tool to the
workbuddy2api-go gateway's agenttool web-search passthrough (`0057-web-search-tool.patch`):

```
DSH session ── ctx.web.search() ──▶ this provider ──▶ POST {gateway}/v1/tools/search
                                                          │ account-pool rotation + 15001 cooldown
                                                          ▼
                                              https://www.workbuddy.cn/agenttool/v1/search
```

- Provider id: `workbuddy-gateway`
- Pin: `web.searchProvider: workbuddy-gateway` in `cordis.patch.yml`
- Credential: `apiKeyEnv` (default `WORKBUDDY_MANNAGER_CN_API_KEY`), resolved via
  the credentials service or the launch environment
- Result: `{code:0, results:[{title,url,snippet}]}` envelope mapped to
  `{url,title,snippet,summary}` sources; `maxResults` truncation is owned by the seam

## Error vocabulary

| Situation | WebError code |
|---|---|
| No gateway key configured | `WEB_PROVIDER_CREDENTIAL_MISSING` |
| Gateway unreachable / non-2xx / upstream business code ≠ 0 | `WEB_PROVIDER_ERROR` |
| All-pool search quota exhausted (15001, gateway 429 `quota_web_search`) | `WEB_PROVIDER_ERROR` (message says quota) |
| Caller cancellation | `WEB_ABORTED` |
