// 功能验证：mock 网关 + 假 ctx，走完整的 apply → ready → search 链路。
// 覆盖两条解析路径：零配置自动派生（route profile）与显式配置，以及
// v0.4.0 新增的 agenttool 全参数（type/max_results/allowed_domains/
// blocked_domains/freshness）在 wire body 上的透传、覆盖与校验。
// 运行：node test/run.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
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
    } else if (mode === "hang") {
      // 故意不响应：用于 timeoutMs 分支（客户端自行超时）。
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

function makeCtx({ withSessionRoute = true, credentialValue = KEY, toolHarness = undefined } = {}) {
  const registered = [];
  const ctx = {
    get(service) {
      if (service === "tools" && toolHarness !== undefined) return toolHarness.tools;
      if (service === "systemPrompt" && toolHarness !== undefined) return toolHarness.systemPrompt;
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
            // 模拟真实 dsh-llm-pi-ai：同时列出未配置的内置目录 provider 与已配置的路由
            { provider: "openai", settingsNs: "llm-pi-ai", settingsPath: ["providers", "openai"] },
            { provider: "anthropic", settingsNs: "llm-pi-ai", settingsPath: ["providers", "anthropic"] },
            { provider: ROUTE, settingsNs: "llm-pi-ai", settingsPath: ["providers", ROUTE] },
          ],
        };
      }
      if (service === "loader") {
        return {
          entries: () => [
            {
              options: { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" },
              // 真实 dsh-llm-pi-ai 中 providers 是 .volatile()，effectiveConfig.providers 为 { get() } 包装
              fiber: { state: 2, effectiveConfig: { providers: { get: () => ({ [ROUTE]: routeProfile }) } } },
            },
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
    web: {
      registerSearchProvider: (p) => registered.push(p),
      search: (request, signal) => registered[0].search(request, signal),
      searchReady: async (llmProvider) => registered[0].ready(llmProvider),
    },
    inject: (deps, callback) => callback(ctx),
  };
  return { ctx, registered };
}

// 用真实 Config 生成 schemastery 配置对象（每个字段是 {get()} 包装），
// 再叠加测试覆盖；与 cordis 注入到 apply() 的形态一致。
const cfgOf = (over = {}) => {
  const raw = Config({
    ...(over.baseURL !== undefined ? { baseURL: over.baseURL } : {}),
    ...(over.apiKeyEnv !== undefined ? { apiKeyEnv: over.apiKeyEnv } : {}),
    ...(over.type !== undefined ? { type: over.type } : {}),
    ...(over.allowedDomains !== undefined ? { allowedDomains: over.allowedDomains } : {}),
    ...(over.blockedDomains !== undefined ? { blockedDomains: over.blockedDomains } : {}),
    ...(over.freshness !== undefined ? { freshness: over.freshness } : {}),
    ...(over.maxResults !== undefined ? { maxResults: over.maxResults } : {}),
    ...(over.maxRetries !== undefined ? { maxRetries: over.maxRetries } : {}),
    ...(over.modelControlled !== undefined ? { modelControlled: over.modelControlled } : {}),
    ...(over.modelMaxQueries !== undefined ? { modelMaxQueries: over.modelMaxQueries } : {}),
    ...(over.modelSummaryMaxChars !== undefined ? { modelSummaryMaxChars: over.modelSummaryMaxChars } : {}),
  });
  // 测试里统一固定超时，避免 hang 分支拖慢整套用例。
  return {
    ...raw,
    timeoutMs: { get: () => over.timeoutMs ?? 5000 },
    maxResults: { get: () => over.maxResults ?? 5 },
    maxRetries: { get: () => over.maxRetries ?? 0 },
  };
};

// apply 的 config 是 schemastery 对象（每个字段是 {get()} 包装），cfgOf 已对齐。
function register(over) {
  const { ctx, registered } = makeCtx();
  apply(ctx, cfgOf(over));
  return registered[0];
}

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
  assert.equal(lastReq.body.type, "text2text", "agenttool type 默认 text2text");
  assert.equal(lastReq.body.max_results, 5);
  assert.equal("allowed_domains" in lastReq.body, false, "空 allowed_domains 省略");
  assert.equal("blocked_domains" in lastReq.body, false, "空 blocked_domains 省略");
  assert.equal("freshness" in lastReq.body, false, "未配置 freshness 省略");
  assert.equal(out.sources.length, 1, "url filter + dedupe");
  assert.equal(out.sources[0].url, "https://go.dev/blog/generics");
  console.log("✓ 自动派生：apiKeyEnv + baseURL(from /v1/ strip) + 全参数默认形态 + search OK");
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

console.log("\n== B2. agenttool 全参数（Config 默认值 → wire body） ==");
{
  const p = register({
    type: "text2text",
    maxResults: 7,
    allowedDomains: ["https://go.dev/docs/", "blog.golang.org", " go.dev ", "GO.DEV"],
    blockedDomains: ["https://reddit.com/r/golang", " .stackoverflow.com ", "", "reddit.com"],
    freshness: "m1",
  });
  await p.search({ query: "go generics" });
  assert.deepEqual(lastReq.body, {
    query: "go generics",
    type: "text2text",
    max_results: 7,
    allowed_domains: ["go.dev", "blog.golang.org"],       // 去 scheme/path + 去重
    blocked_domains: ["reddit.com", "stackoverflow.com"], // 同上，去空项
    freshness: "m1",
  });
  console.log("✓ type/max_results/allowed_domains/blocked_domains/freshness 全部落进请求体，域名归一化 + 去重");
}

{
  // Config schema 的 freshness 枚举校验
  assert.throws(() => Config({ freshness: "forever" }), /d1.*m1.*y1|expected/);
  assert.doesNotThrow(() => Config({ freshness: "d1" }));
  console.log("✓ Config.freshness 枚举：d1/m1/y1 接受，非法值拒绝");
}

console.log("\n== B3. 每请求覆盖（camelCase 与 snake_case 两种写法） ==");
{
  const p = register({
    type: "text2text",
    maxResults: 5,
    allowedDomains: ["default.example"],
    blockedDomains: ["default-blacklist.example"],
    freshness: "y1",
  });
  await p.search({
    query: "override cfg",
    type: "text2text",
    maxResults: 3,
    allowedDomains: ["camel.example"],
    blockedDomains: ["camel-block.example"],
    freshness: "d1",
  });
  assert.deepEqual(lastReq.body, {
    query: "override cfg",
    type: "text2text",
    max_results: 3,
    allowed_domains: ["camel.example"],
    blocked_domains: ["camel-block.example"],
    freshness: "d1",
  }, "camelCase 覆盖优先于 Config");

  await p.search({
    query: "snake override",
    max_results: 12,
    allowed_domains: ["snake.example"],
    blocked_domains: ["snake-block.example"],
    freshness: "m1",
  });
  assert.deepEqual(lastReq.body.allowed_domains, ["snake.example"], "snake_case 字段同样生效");
  assert.deepEqual(lastReq.body.blocked_domains, ["snake-block.example"]);
  assert.equal(lastReq.body.max_results, 12);
  assert.equal(lastReq.body.freshness, "m1");
  console.log("✓ 请求级覆盖（camelCase / snake_case）均优先于 Config 默认值");
}

console.log("\n== B4. 边界与校验 ==");
{
  const p = register({});
  await p.search({ query: "clamp high", maxResults: 999 });
  assert.equal(lastReq.body.max_results, 20, "max_results 上限 20（0057 网关约束）");
  await p.search({ query: "clamp low", maxResults: -3 });
  assert.equal(lastReq.body.max_results, 5, "非法值回退到 Config 默认 5");
  console.log("✓ max_results 钳制到 1..20，非法值回退默认值");
}
{
  const p = register({});
  await assert.rejects(
    () => p.search({ query: "bad freshness", freshness: "forever" }),
    (e) => e instanceof WebError && e.code === "WEB_PROVIDER_ERROR" && /freshness/.test(e.message),
  );
  console.log("✓ 非法 freshness → WEB_PROVIDER_ERROR（不发出请求）");
}
{
  // 脏的运行时配置（绕过 Config schema 直接注入）：非数组域名应被安全忽略
  const { ctx, registered } = makeCtx();
  apply(ctx, { ...cfgOf(), blockedDomains: { get: () => "not-an-array" } });
  const p = registered[0];
  await p.search({ query: "robust" });
  assert.equal("blocked_domains" in lastReq.body, false);
  console.log("✓ 非数组域名配置被安全忽略");
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
  // timeoutMs 生效（网关挂起不响应）
  mode = "hang";
  const { ctx, registered } = makeCtx();
  apply(ctx, cfgOf({ timeoutMs: 120 }));
  const p = registered[0];
  await assert.rejects(
    () => p.search({ query: "q" }),
    (e) => e instanceof WebError && /timed out/.test(e.message),
  );
  console.log("✓ timeoutMs 超时 → WEB_PROVIDER_ERROR(timed out)");
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

console.log("\n== D. modelControlled：模型可自主传过滤参数 ==");
{
  mode = "ok";
  const toolDefs = [];
  const promptSections = [];
  const toolHarness = {
    tools: {
      register: (def, opts) => { toolDefs.push({ def, opts }); return () => {}; },
    },
    systemPrompt: {
      section: (s) => { promptSections.push(s); return () => {}; },
      getSectionOrder: () => 2000,
    },
  };
  const { ctx } = makeCtx({ toolHarness });
  apply(ctx, cfgOf({ modelControlled: true, maxResults: 5 }));

  assert.equal(toolDefs.length, 1, "注册了插件自有 web_search");
  const tool = toolDefs[0].def;
  assert.equal(tool.name, "web_search");
  assert.equal(typeof toolDefs[0].opts.when, "function", "带 searchReady 激活条件");
  for (const key of ["allowedDomains", "blockedDomains", "freshness", "maxResults"]) {
    assert.ok(tool.parameters.properties[key], `参数 schema 暴露 ${key}`);
  }
  assert.equal(tool.parameters.additionalProperties, false, "拒绝未知字段");
  assert.equal(promptSections.length, 1, "注册了模型提示段");
  assert.match(promptSections[0].text, /allowedDomains/);

  // 模型传入过滤参数 → execute 把它们放进 ctx.web.search() 的 request → 落进 wire body
  const out = await tool.execute({
    queries: ["model controlled"],
    allowedDomains: ["go.dev"],
    blockedDomains: ["reddit.com"],
    freshness: "d1",
    maxResults: 3,
  }, { signal: new AbortController().signal });
  assert.deepEqual(lastReq.body, {
    query: "model controlled",
    type: "text2text",
    max_results: 3,
    allowed_domains: ["go.dev"],
    blocked_domains: ["reddit.com"],
    freshness: "d1",
  });
  assert.equal(out.sources.length, 1, "结果映射正常");
  assert.equal(out.truncated, false);

  // render / presentationMeta / presentResult 全链路
  const blocks = tool.output.render({}, out);
  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text, /Sources:/);
  const meta = tool.output.presentationMeta({}, out);
  assert.equal(meta.sources.length, 1);
  const view = tool.presentResult({ queries: ["model controlled"] }, { isError: false, meta });
  assert.equal(view.card, "web");
  assert.equal(view.kind, "search");

  // 非法参数在 execute 层被拒，不发请求
  await assert.rejects(
    () => tool.execute({ queries: ["x"], freshness: "forever" }, { signal: new AbortController().signal }),
    /freshness must be one of/,
  );
  await assert.rejects(
    () => tool.execute({ queries: [] }, { signal: new AbortController().signal }),
    /queries must contain at least one query/,
  );
  console.log("✓ 模型级 allowedDomains/blockedDomains/freshness/maxResults → wire body；schema/展示/校验均通过");
}

{
  // 默认关闭：不触碰 tools/systemPrompt
  const { ctx, registered } = makeCtx();
  assert.doesNotThrow(() => apply(ctx, cfgOf()));
  assert.equal(registered.length, 1, "只注册 provider");
  console.log("✓ modelControlled 默认 false，不注册重复工具");
}

console.log("\n== D2. modelControlled：agent.ctx 局部遮蔽（兼容 preset 内置 tool-web） ==");
{
  mode = "ok";
  const globalRegistered = [];
  const agentRegistered = [];
  const agentPrompts = [];
  const listeners = new Map();
  const toolHarness = {
    tools: {
      // 模拟根级已有官方 tool-web 注册的 web_search
      get: (name) => (name === "web_search" ? { name: "web_search" } : undefined),
      register: (def, opts) => {
        globalRegistered.push({ def, opts });
        throw new Error('tool "web_search" is already registered');
      },
    },
    systemPrompt: {
      section: () => () => {},
    },
  };
  const { ctx } = makeCtx({ toolHarness });
  ctx.on = (event, fn) => {
    listeners.set(event, fn);
    return () => listeners.delete(event);
  };
  assert.doesNotThrow(() => apply(ctx, cfgOf({ modelControlled: true, maxResults: 5 })));
  assert.equal(globalRegistered.length, 0, "根级已存在 web_search 时跳过全局重复注册");
  assert.equal(typeof listeners.get("agent/created"), "function", "已监听 agent/created");

  // 触发新会话 agent/created → 应在 agent.ctx 注册 5 参数 web_search 遮蔽 preset
  const fakeAgent = {
    id: "session-test-1",
    ctx: {
      get(service) {
        if (service === "tools") {
          return {
            register: (def, opts) => { agentRegistered.push({ def, opts }); return () => {}; },
          };
        }
        if (service === "systemPrompt") {
          return {
            section: (s) => { agentPrompts.push(s); return () => {}; },
          };
        }
        return undefined;
      },
    },
  };
  listeners.get("agent/created")({ agent: fakeAgent });
  assert.equal(agentRegistered.length, 1, "agent.ctx 成功注册 5 参数 web_search");
  assert.equal(agentRegistered[0].def.name, "web_search");
  for (const key of ["queries", "allowedDomains", "blockedDomains", "freshness", "maxResults"]) {
    assert.ok(agentRegistered[0].def.parameters.properties[key], `agent.ctx 工具暴露 ${key}`);
  }
  assert.equal(agentPrompts.length, 1, "agent.ctx 同步注入提示词段");
  console.log("✓ agent/created 在 agent.ctx 注册 5 参数 web_search，遮蔽 preset/根级 1 参数工具且无重复报错");
}

console.log("\n== D3. 非 pi-ai 会话路由回退 + 单侧显式 apiKeyEnv ==");
{
  const { ctx, registered } = makeCtx();
  // 模拟会话切换到 deepseek-official（非 llm-pi-ai 路由），但 llm-pi-ai 里唯一配置了 workbuddy-mannager-cn
  const origGet = ctx.get.bind(ctx);
  ctx.get = (svc) => {
    if (svc === "agents") {
      return {
        currentInitiator: () => ({
          session: { requestContext: () => ({ provider: "deepseek-official" }) },
        }),
      };
    }
    return origGet(svc);
  };
  apply(ctx, cfgOf());
  const p = registered[0];
  assert.equal(await p.ready("deepseek-official"), true, "切到非 pi-ai 模型时仍回退到唯一 pi-ai 路由");
  const out = await p.search({ query: "fallback route" });
  assert.equal(out.sources.length, 1);
  console.log("✓ 非 pi-ai 会话路由自动回退唯一 llm-pi-ai 路由，ready() 与 search() 均正常");
}

{
  // 仅显式配置 apiKeyEnv（省略 baseURL 且无 llm 服务）：ready() 应返回 true，且 baseURL 兜底 http://127.0.0.1:7864
  const { ctx, registered } = makeCtx({ withSessionRoute: false });
  const origGet = ctx.get.bind(ctx);
  ctx.get = (svc) => (svc === "llm" ? undefined : origGet(svc));
  apply(ctx, cfgOf({ apiKeyEnv: "WORKBUDDY_MANNAGER_CN_API_KEY" }));
  const p = registered[0];
  assert.equal(await p.ready(), true, "单侧显式 apiKeyEnv 时 ready() 为 true");

  const origFetch = globalThis.fetch;
  let capturedUrl = null;
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return new Response(searchOK, { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const out = await p.search({ query: "default base url" });
    assert.equal(capturedUrl, "http://127.0.0.1:7864/v1/tools/search", "缺省 baseURL 兜底 http://127.0.0.1:7864");
    assert.equal(out.sources.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
  console.log("✓ 单侧显式 apiKeyEnv：ready() 为 true，baseURL 兜底 http://127.0.0.1:7864");
}

console.log("\n== D4. blockedDomains 本地结果后过滤（精确域名 + 子域名） ==");
{
  const p = register({});
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 0,
    msg: "",
    results: [
      { title: "Exact blocked", url: "https://artificialintelligence-news.com/", snippet: "blocked" },
      { title: "Subdomain blocked", url: "https://www.wikiwand.com/zh-hant/articles/Hello,_world", snippet: "blocked" },
      { title: "Kept", url: "https://go.dev/blog/generics", snippet: "kept" },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const out = await p.search({
      query: "hello world",
      blockedDomains: ["artificialintelligence-news.com", "wikiwand.com"],
    });
    assert.deepEqual(out.sources.map((s) => s.url), ["https://go.dev/blog/generics"]);
  } finally {
    globalThis.fetch = origFetch;
  }
  console.log("✓ blockedDomains 同时在结果侧过滤精确域名与 www. 等子域名");
}

console.log("\n== D5. 自动重试（默认最多 2 次，可配置 maxRetries，界面卡片 + 日志提示） ==");
{
  const warnLogs = [];
  const toolDefs = [];
  const toolHarness = {
    tools: { register: (def, opts) => { toolDefs.push({ def, opts }); return () => {}; } },
    systemPrompt: { section: () => () => {} },
  };
  const { ctx } = makeCtx({ toolHarness });
  const origGet = ctx.get.bind(ctx);
  ctx.get = (svc) => (svc === "logger" ? { warn: (m) => warnLogs.push(m) } : origGet(svc));

  // 使用真实 Config 默认值（maxRetries = 2）
  const rawCfg = Config({ modelControlled: true });
  apply(ctx, rawCfg);

  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 2) {
      return new Response("bad gateway", { status: 502 });
    }
    return new Response(searchOK, { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const tool = toolDefs[0].def;
    const out = await tool.execute({ queries: ["retry test"] }, { signal: new AbortController().signal });
    assert.equal(calls, 3, "默认最多 2 次重试（1 次初始 + 2 次重试）");
    assert.equal(warnLogs.length, 2, "每次重试记录 logger.warn");
    assert.match(warnLogs[0], /retrying \(1\/2\)/);
    assert.match(warnLogs[1], /retrying \(2\/2\)/);
    const meta = tool.output.presentationMeta({}, out);
    assert.equal(meta.retries, 2);
    const view = tool.presentResult({ queries: ["retry test"] }, { isError: false, meta });
    assert.match(view.title, /\(重试 2 次\)/, "界面卡片标题显示重试次数");
  } finally {
    globalThis.fetch = origFetch;
  }

  // 429 配额耗尽不应重试
  let quotaCalls = 0;
  globalThis.fetch = async () => {
    quotaCalls += 1;
    return new Response(quota429, { status: 429, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(
      () => toolDefs[0].def.execute({ queries: ["quota"] }, { signal: new AbortController().signal }),
      (e) => e instanceof WebError && /quota exhausted/.test(e.message),
    );
    assert.equal(quotaCalls, 1, "429 quota_web_search 不重试");
  } finally {
    globalThis.fetch = origFetch;
  }
  console.log("✓ 默认最多重试 2 次，logger.warn 与卡片标题提示重试次数，429 配额不重试");
}

console.log("\n== E. peerDependencies 范围约束（避免精确钉死单一 DSH rc） ==");
{
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const dep of ["@deepseek-ai/dsh-web", "@deepseek-ai/dsh-credentials"]) {
    const range = pkg.peerDependencies?.[dep];
    assert.equal(typeof range, "string", `${dep} 必须在 peerDependencies 中声明`);
    assert.match(range, /^>=0\.2\.2-rc\.\d+\s+<0\.3\.0-0$/, `${dep} 应使用覆盖 0.2.x 且排除 0.3.0 prerelease 的 semver 范围，实际: ${range}`);
  }
  console.log("✓ @deepseek-ai/dsh-web 与 @deepseek-ai/dsh-credentials 使用 semver 范围而非精确 rc 版本");
}

gw.close();
console.log("\nALL PLUGIN TESTS PASSED");
