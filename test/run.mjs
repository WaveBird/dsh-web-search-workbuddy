// 功能验证：mock 网关 + 假 ctx，走完整的 apply → ready → search 链路。
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
      res.destroy(); // connection refused-like
    }
  });
});
await new Promise((r) => gw.listen(0, "127.0.0.1", r));
const baseURL = `http://127.0.0.1:${gw.address().port}`;

// ---- fake ctx / config --------------------------------------------------
const envKey = process.env.WORKBUDDY_MANNAGER_CN_API_KEY ?? "test-key-123";
process.env.WORKBUDDY_MANNAGER_CN_API_KEY = envKey;

const registered = [];
const ctx = { get: () => undefined }; // no credentials service → env fallback
let provider = null;

// Config sections: cordis Config objects expose .get()
const cfg = {
  baseURL: { get: () => baseURL },
  apiKeyEnv: { get: () => "WORKBUDDY_MANNAGER_CN_API_KEY" },
  timeoutMs: { get: () => 5000 },
  maxResults: { get: () => 5 },
};

apply({ get: ctx.get, web: { registerSearchProvider: (p) => registered.push(p) } }, cfg);
assert.equal(registered.length, 1, "provider registered");
provider = registered[0];
assert.equal(provider.id, PROVIDER_ID);

console.log("✓ provider registered:", provider.id);

// available()
assert.equal(provider.available(), true, "available with parseable baseURL");
console.log("✓ available() true");

// ready()
assert.equal(await provider.ready(), true, "ready with env key");
console.log("✓ ready() true (env key present)");

// search ok
{
  const out = await provider.search({ query: "go generics", maxResults: 5 });
  assert.equal(lastReq.path, "/v1/tools/search");
  assert.equal(lastReq.auth, `Bearer ${envKey}`);
  assert.equal(lastReq.body.query, "go generics");
  assert.equal(lastReq.body.max_results, 5);
  assert.equal(out.truncated, false);
  assert.equal(out.sources.length, 1, "bad-url + dup filtered");
  assert.equal(out.sources[0].url, "https://go.dev/blog/generics");
  assert.equal(out.sources[0].snippet, "generics in Go");
  assert.equal(out.sources[0].title, "Go generics");
  console.log("✓ search ok: envelope mapped, url filter + dedupe");
}

// search maxResults default from config
{
  await provider.search({ query: "x" });
  assert.equal(lastReq.body.max_results, 5);
  console.log("✓ default max_results from config");
}

// quota (HTTP 429 + quota_web_search)
{
  mode = "quota";
  await assert.rejects(
    () => provider.search({ query: "q" }),
    (e) => e instanceof WebError && e.code === "WEB_PROVIDER_ERROR" && /quota exhausted/.test(e.message),
    "429 quota message",
  );
  console.log("✓ 429 quota_web_search → WEB_PROVIDER_ERROR with quota wording");
}

// business code passthrough (HTTP 200 + code 15001)
{
  mode = "bizcode";
  await assert.rejects(
    () => provider.search({ query: "q" }),
    (e) => e instanceof WebError && e.code === "WEB_PROVIDER_ERROR" && /15001/.test(e.message),
  );
  console.log("✓ HTTP200 code=15001 → WEB_PROVIDER_ERROR");
}

// gateway down
{
  mode = "down";
  await assert.rejects(
    () => provider.search({ query: "q" }),
    (e) => e instanceof WebError && e.code === "WEB_PROVIDER_ERROR" && /request failed/.test(e.message),
  );
  console.log("✓ gateway unreachable → WEB_PROVIDER_ERROR with endpoint hint");
}

// credential missing
{
  delete process.env.WORKBUDDY_MANNAGER_CN_API_KEY;
  await assert.rejects(
    () => provider.search({ query: "q" }),
    (e) => e instanceof WebError && e.code === "WEB_PROVIDER_CREDENTIAL_MISSING",
  );
  process.env.WORKBUDDY_MANNAGER_CN_API_KEY = envKey;
  console.log("✓ no key → WEB_PROVIDER_CREDENTIAL_MISSING");
}

// cancellation honors signal
{
  mode = "ok";
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => provider.search({ query: "q" }, ac.signal),
    (e) => e instanceof WebError && e.code === "WEB_ABORTED",
  );
  console.log("✓ aborted signal → WEB_ABORTED");
}

gw.close();
console.log("\nALL PLUGIN TESTS PASSED");
