// 功能验证：mock 网关 + 假 ctx，走完整的 apply → ready → search 链路。
// 覆盖两条解析路径：零配置自动派生（route profile）与显式配置。
// 运行：node test/run.mjs
import { createServer } from "node:http";
import assert from "node:assert";
import { PROVIDER_ID, apply, Config } from "../lib/index.js";
import { WebError } from "@deepseek-ai/dsh-web";

// ---- fake gateway -------------------------------------------------------
const searchOK = JSON.stringify({
  code: 0, msg: "",
  results: [
    { title: "Go generics", url: "https://go.dev/blog/generics", snippet: "generics in Go" },
    { title: "bad url", url: "javascript:alert(1)", snippet: "should be filtered" },
    { title: "dup", url: "https://go.dev/blog/generics", snippet: "dup" },
  ],
  total_results: 3, response_time_ms: 12, provider: "bocha",
});
const quota429 = JSON.stringify({
  error: "web search quota exhausted on all available accounts (upstream code 15001); quota resets daily",
  code: "quota_web_search", tried: 2,
});

let mode = "ok";
let lastReq = null;
const gw = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastReq = { auth: req.headers.authorization, body: JSON.parse(body), path: req.url };
    if (mode === "ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(searchOK);
    } else if (mode === "quota") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(quota429);
    } else if (mode === "bizcode") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 15001, msg: "quota_web_search" }));
    } else if (mode === "down") {
      res.destroy();
    }
  });
});
await new Promise((r) => gw.listen(0, "127.0.0.1", r));
const gatewayOrigin = `http://127.0.0.1:${gw.address().port}`;

// ---- fake environment ---------------------------------------------------
const KEY = "wbk_test_key_123";
process.env.WORKBUDDY_MANNAGER_CN_API_KEY = KEY;

const ROUTE = "workbuddy-mannager-cn";
// 模型路由 profile：baseURL 带 /v1/（chat 面），apiKeyEnv 与模型共用
const routeProfile = {
  apiKeyEnv: "WORKBUDDY_MANNAGER_CN_API_KEY",
  baseURL: `${gatewayOrigin}/v1/`,
};

function makeCtx({ withSessionRoute = true, credentialValue = KEY } = {}) {
  const registered = [];
  const ctx = {
    get(service) {
      if (service === "credentials") {
        return {
          resolve: async (ref) => ({ value: credentialValue === null ? undefined : credentialValue }),
          describe: async (ref) => ({ configured: credentialValue !== null }),
        };
      }
      if (service === "llm") {
        return {
          listProviders: () => [{ id: ROUTE, name: ROUTE }],
          listConfigurableProviders: () => [
            { provider: ROUTE, settingsNs: "llm-pi-ai", settingsPath: ["providers", ROUTE] },
          ],
        };
      }
      if (service === "loader") {
        return {
          entries: () => [
            { options: { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" },
              fiber: { state: 2, effectiveConfig: { providers: { [ROUTE]: routeProfile } } } },
          ],
        };
      }
      if (service === "agents") {
        // 模拟一个正在进行的会话，其 requestContext.provider 指向模型路由
        if (!withSessionRoute) return undefined;
        return {
          currentInitiator: () => ({
            session: { requestContext: () => ({ provider: ROUTE }) },
          }),
        };
      }
      return undefined;
    },
    web: { registerSearchProvider: (p) => registered.push(p) },
  };
  return { ctx, registered };
}

const cfgOf = (over = {}) => ({
  baseURL: { get: () => over.baseURL },
  apiKeyEnv: { get: () => over.apiKeyEnv },
  timeoutMs: { get: () => 5000 },
  maxResults: { get: () => 5 },
});

// =========================================================================
console.log("== A. 零配置自动派生（路由 profile → apiKeyEnv + baseURL） ==");
{
  const { ctx, registered } = makeCtx();
  apply(ctx, cfgOf());  // baseURL/apiKeyEnv 均未配置
  const p = registered[0];
  assert.equal(p.id, PROVIDER_ID);
  assert.equal(p.available(), true, "available (no-op: presence checked at ready/search)");
  assert.equal(await p.ready(ROUTE), true, "ready via route profile");
  const out = await p.search({ query: "go generics", maxResults: 5 });
  // baseURL 从 route profile 的 /v1/ 后缀剥离 → 打到 /v1/tools/search 同源
  assert.equal(lastReq.path, "/v1/tools/search");
  assert.equal(lastReq.auth, `Bearer ${KEY}`);
  assert.equal(lastReq.body.query, "go generics");
  assert.equal(out.sources.length, 1, "url filter + dedupe");
  assert.equal(out.sources[0].url, "https://go.dev/blog/generics");
  console.log("✓ 自动派生：apiKeyEnv + baseURL(from /v1/ strip) + search OK");
}

{
  // ready() 用 llmProvider 参数（tool-web 传入的模型路由）而非会话
  const { ctx, registered } = makeCtx({ withSessionRoute: false });
  apply(ctx, cfgOf());
  const p = registered[0];
  assert.equal(await p.ready(ROUTE), true, "ready(llmProvider=route)");
  console.log("✓ ready(llmProvider) 走显式路由参数");
}

console.log("\n== B. 显式配置覆盖（仍支持） ==");
{
  const { ctx, registered } = makeCtx();
  apply(ctx, cfgOf({ baseURL: gatewayOrigin, apiKeyEnv: "WORKBUDDY_MANNAGER_CN_API_KEY" }));
  const p = registered[0];
  const out = await p.search({ query: "explicit cfg" });
  assert.equal(lastReq.body.query, "explicit cfg");
  console.log("✓ 显式 baseURL + apiKeyEnv 仍生效");
}

console.log("\n== C. 错误路径 ==");
{
  // 无密钥：credentials 服务返回空 且 环境变量不存在
  const saved = process.env.WORKBUDDY_MANNAGER_CN_API_KEY;
  delete process.env.WORKBUDDY_MANNAGER_CN_API_KEY;
  const { ctx, registered } = makeCtx({ credentialValue: null });
  apply(ctx, cfgOf());
  const p = registered[0];
  await assert.rejects(
    () => p.search({ query: "q" }),
    (e) => e instanceof WebError && e.code === "WEB_PROVIDER_CREDENTIAL_MISSING",
  );
  process.env.WORKBUDDY_MANNAGER_CN_API_KEY = saved;
  console.log("✓ 密钥缺失（服务+环境都无值）→ WEB_PROVIDER_CREDENTIAL_MISSING");
}

{
  // 无路由且无显式配置 → CONFIGURED_MISSING（而非静默失败）
  const { ctx, registered } = makeCtx({ withSessionRoute: false });
  // 让 llm 不可用
  ctx.get = (svc) => svc === "llm" ? undefined : undefined;
  apply(ctx, cfgOf());
  const p = registered[0];
  await assert.rejects(
    () => p.search({ query: "q" }),
    (e) => e instanceof WebError && e.code === "WEB_PROVIDER_CONFIGURED_MISSING",
  );
  console.log("✓ 无路由无配置 → WEB_PROVIDER_CONFIGURED_MISSING（结构化报错）");
}

{
  // 429 配额
  const { ctx, registered } = makeCtx();
  apply(ctx, cfgOf());
  const p = registered[0];
  mode = "quota";
  await assert.rejects(
    () => p.search({ query: "q" }),
    (e) => e instanceof WebError && e.code === "WEB_PROVIDER_ERROR" && /quota exhausted/.test(e.message),
  );
  console.log("✓ 429 quota_web_search → WEB_PROVIDER_ERROR");
}

{
  // HTTP200 + 业务码 15001
  mode = "bizcode";
  const { ctx, registered } = makeCtx();
  apply(ctx, cfgOf());
  const p = registered[0];
  await assert.rejects(
    () => p.search({ query: "q" }),
    (e) => e instanceof WebError && /15001/.test(e.message),
  );
  console.log("✓ HTTP200 code=15001 → WEB_PROVIDER_ERROR");
}

{
  // 网关不可达
  mode = "down";
  const { ctx, registered } = makeCtx();
  apply(ctx, cfgOf());
  const p = registered[0];
  await assert.rejects(
    () => p.search({ query: "q" }),
    (e) => e instanceof WebError && /request failed/.test(e.message),
  );
  console.log("✓ gateway unreachable → WEB_PROVIDER_ERROR");
}

{
  // 取消
  mode = "ok";
  const { ctx, registered } = makeCtx();
  apply(ctx, cfgOf());
  const p = registered[0];
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => p.search({ query: "q" }, ac.signal),
    (e) => e instanceof WebError && e.code === "WEB_ABORTED",
  );
  console.log("✓ aborted signal → WEB_ABORTED");
}

gw.close();
console.log("\nALL PLUGIN TESTS PASSED");
