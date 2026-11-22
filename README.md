# dsh-web-search-workbuddy

面向 **DeepSeek Harness（DSH）** 联网能力接口（`ctx.web`）的 WorkBuddy 网关搜索提供器插件。

它将 DSH 的 `web_search` 工具桥接到 `workbuddy2api-go` 网关的 agenttool 搜索透传接口，并以 [workbuddy-manager](https://github.com/WaveBird/workbuddy-manager) 作为统一入口代理——**只需一把 `wbk_` 密钥，即可同时服务对话请求与 `web_search` 联网搜索**。

```text
DSH 会话 ── ctx.web.search() ──▶ dsh-web-search-workbuddy
                                      │  POST {manager}:7864/v1/tools/search   (Bearer wbk_...)
                                      ▼
                             workbuddy-manager  （鉴权 + 上游路由解析 + 日志）
                                      │  POST {wb2api-go}:7863/v1/tools/search
                                      ▼
                             wb2api-go          （多账号池轮询 + 15001 额度冷却）
                                      ▼
                             https://www.workbuddy.cn/agenttool/v1/search  (CN)
                             https://www.workbuddy.ai/agenttool/v1/search  (Global)
```

### 核心特性

- **零配置自动复用密钥与地址**：默认自动读取当前会话所用模型路由（`llm-pi-ai`）的 `baseURL` 和 `apiKeyEnv`，多路由切换时搜索自动跟随，无需重复配置。
- **支持 agenttool 完整过滤参数（v0.4.0+）**：支持 `type`、`max_results`、`allowed_domains`、`blocked_domains`、`freshness`（`d1` / `m1` / `y1`）。
- **可选「模型自主控制过滤」模式（v0.4.1+）**：开启 `modelControlled: true` 后，模型可在每次调用 `web_search` 时自行决定限定域名、排除域名、时效与返回条数，无需魔改任何 DSH 官方文件。
- **宽范围 DSH 兼容（v0.4.2+）**：`peerDependencies` 声明为 `>=0.2.2-rc.1 <0.3.0-0`，升级 DSH `0.2.x` 小版本 / rc 版本不会再被安装器拒绝或启动器禁用。

---

## 一、快速安装

### 1. 一键安装与配置脚本（最推荐，跨平台支持 macOS / Linux / Windows）

脚本位于 [`scripts/`](./scripts/) 目录，执行前会自动检测全部前置条件（Node.js ≥ 20、`dsh` 命令与版本范围 `>=0.2.2-rc.1 <0.3.0-0`、在线安装源连通性、profile 目录权限以及 `workbuddy-manager` 搜索路由可达性），遇到问题会明确打印原因与解决办法。

检测到仅有 1 个 DSH profile 时会自动选用，完成插件安装、关闭 DSH 默认搜索、切换 `searchProvider: workbuddy-gateway` 与配置校验；若检测到正在运行的 DSH 进程，会询问是否重启（直接按回车确认）。

**macOS / Linux（Bash）：**

```bash
curl -fsSL https://raw.githubusercontent.com/WaveBird/dsh-web-search-workbuddy/main/scripts/install.sh | bash
```

**Windows（PowerShell 5.1 / 7+）：**

```powershell
irm https://raw.githubusercontent.com/WaveBird/dsh-web-search-workbuddy/main/scripts/install.ps1 | iex
```

**Windows（CMD / 双击运行）：**

克隆或下载仓库后直接双击 [`scripts/install.bat`](./scripts/install.bat)，或在 CMD 中执行：

```bat
scripts\install.bat
```

常用参数（均支持三个脚本；`curl | bash` 请通过 `bash -s -- ...` 传参）：

```bash
# 指定 profile（如 desktop / web）
./scripts/install.sh --profile desktop
# PowerShell:
.\scripts\install.ps1 -Profile desktop
# CMD:
scripts\install.bat --profile desktop

# 仅注册底层搜索 provider，保留官方 1 参数 web_search（默认脚本已开启 5 参数 modelControlled: true）
./scripts/install.sh --provider-only
# PowerShell: .\scripts\install.ps1 -ProviderOnly

# 从 GitHub main 分支安装最新代码（不走 npm）
./scripts/install.sh --github
# PowerShell: .\scripts\install.ps1 -Github
```

> 脚本在修改 `cordis.patch.yml` 前会自动备份原文件（`cordis.patch.yml.bak.<时间戳>`），并用独立标记块托管配置，支持重复执行幂等更新；若 `dsh --dump-config` 校验失败会自动回滚备份。

### 2. 手动使用 DSH 插件命令安装

```bash
# 安装到默认 profile
dsh plugin add dsh-web-search-workbuddy

# 若使用指定 profile（例如 web / desktop / tui），加上 --profile：
dsh plugin --profile web add dsh-web-search-workbuddy
dsh plugin --profile desktop add dsh-web-search-workbuddy
```

> **DSH 桌面版 GUI 安装**：也可以在界面中进入 **设置 → 插件 → 添加插件**，输入包名 `dsh-web-search-workbuddy` 点击安装。手动安装后请继续完成下方「二、配置方法」。

### 3. 其他安装方式（备选）

```bash
# 从 GitHub 主分支直接在线安装最新代码
dsh plugin --profile web add github:WaveBird/dsh-web-search-workbuddy#main

# 或在对应 profile 目录下直接使用 pnpm
cd ~/.dsh/profiles/web && pnpm add dsh-web-search-workbuddy

# 或使用 npm
npm install dsh-web-search-workbuddy
```

> 说明：对等依赖 `@deepseek-ai/dsh-web`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/cordis` 在运行时由 DSH 宿主环境提供；`@deepseek-ai/schemastery` 已作为直接依赖打包。

---

## 二、配置方法：关闭默认 DSH 搜索并切换为本插件

DSH 默认启用了官方 DeepSeek 搜索提供器（`web-search-deepseek`、`web-deepseek-api`），通过 `web`（`@deepseek-ai/dsh-web`）统一调度，再由 `tool-web`（`@deepseek-ai/dsh-tool-web`）向模型暴露 `web_search` 工具。

要**关掉默认的 DSH 搜索并切换到 WorkBuddy 插件搜索**，需要在对应 profile 的 `cordis.patch.yml` 中完成三步：
1. **关闭默认 DSH 搜索提供器**：禁用 `web-search-deepseek`、`web-deepseek-api`（以及可选的 `ui-settings-web-search` 设置页）；
2. **注册本插件**：通过 `- insert:` 插入 `dsh-web-search-workbuddy`；
3. **切换搜索路由**：将 `web`（`@deepseek-ai/dsh-web`）的 `searchProvider` 显式设为 `workbuddy-gateway`（`fetchProvider` 保留 `http`，不影响 `web_fetch`）。

`cordis.patch.yml` 文件路径：
- `web` profile：`~/.dsh/profiles/web/cordis.patch.yml`
- `desktop` profile：`~/.dsh/profiles/desktop/cordis.patch.yml`（Windows 为 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）

下面提供 **3 种常见配置方案**，按需选择其一追加到 `cordis.patch.yml` 即可。

### 方案 A：零配置推荐模式（默认）

适合已经用 `llm-pi-ai` 配置好 `workbuddy-manager` 模型路由的用户。插件会自动从当前会话的模型路由派生网关地址和 `wbk_` 密钥，**无需重复填写地址和 Key**：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml

# 1. 关闭 DSH 默认的 DeepSeek 搜索提供器（避免残留或误走官方搜索）
- id: web-search-deepseek
  disabled: true
- id: web-deepseek-api
  disabled: true
# （可选）隐藏界面中默认的 DeepSeek 搜索设置页
- id: ui-settings-web-search
  disabled: true

# 2. 插入本插件（零配置即可自动复用当前模型路由的 baseURL 与 apiKeyEnv）
- insert:
    - id: web-search-workbuddy
      name: dsh-web-search-workbuddy

# 3. 将 DSH 的搜索提供器切换并固定为 workbuddy-gateway（web_fetch 仍走 http）
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    fetchProvider: http
    searchProvider: workbuddy-gateway

# 4. 保持工具入口 tool-web 开启（底层搜索流量已切到 workbuddy-gateway）
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    search: true
    searchTimeoutMs: 60000
```

> 说明：仅配置 `searchProvider: workbuddy-gateway` 也会强制路由到本插件，但**强烈建议同时禁用 `web-search-deepseek` 与 `web-deepseek-api`**，彻底关闭默认搜索提供器，避免多余的 `DEEPSEEK_API_KEY` 凭据检查或配置歧义。

如果希望在默认模式下设置全局搜索过滤默认值（所有搜索共享），可在 `web-search-workbuddy` 下按需补充 `config`：

```yaml
- insert:
    - id: web-search-workbuddy
      name: dsh-web-search-workbuddy
      config:
        maxResults: 5                # 1..20，默认 5
        allowedDomains: [go.dev]     # 可选：仅返回指定域名
        blockedDomains: [reddit.com] # 可选：排除指定域名
        freshness: m1                # 可选：d1（一天内）| m1（一月内）| y1（一年内）
```

### 方案 B：模型自主控制过滤参数（`modelControlled: true`，v0.4.1+）

DSH 官方的 `@deepseek-ai/dsh-tool-web` 只向模型暴露 `queries` 参数。开启 `modelControlled: true` 后，本插件会接管 `web_search` 工具注册，把 `allowedDomains` / `blockedDomains` / `freshness` / `maxResults` 开放给模型按需传入，并自动注入对应的系统提示词说明。

> **💡 工作原理**：开启 `modelControlled: true` 后，本插件会同时在每个会话的 `agent.ctx` 作用域内注册 5 参数版 `web_search`，自动遮蔽 `preset-standard` / `preset-ptc` / `preset-cordis` 以及根级 `tool-web` 的 1 参数版本，**无需再手动逐个修改每个 agent preset 的配置**（也不会报重复注册错误），`web_fetch` 保持不受影响。

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml

# 1. 关闭 DSH 默认搜索提供器
- id: web-search-deepseek
  disabled: true
- id: web-deepseek-api
  disabled: true
- id: ui-settings-web-search
  disabled: true

# 2. 插入本插件并开启 modelControlled
- insert:
    - id: web-search-workbuddy
      name: dsh-web-search-workbuddy
      config:
        modelControlled: true
        maxResults: 5
        modelMaxQueries: 10
        modelSummaryMaxChars: 800

# 3. 将搜索提供器切换到 workbuddy-gateway
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    fetchProvider: http
    searchProvider: workbuddy-gateway

# 4. 根级 tool-web 关闭 search，保留 fetch: true（各 agent preset 会由本插件在 agent.ctx 中自动遮蔽）
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    search: false
    searchTimeoutMs: 60000
```

模型侧看到的 `web_search` 工具参数格式示例：

```json
{
  "queries": ["go generics"],
  "allowedDomains": ["go.dev"],
  "blockedDomains": ["reddit.com"],
  "freshness": "d1",
  "maxResults": 5
}
```

### 方案 C：显式指定网关地址与密钥

如果搜索服务与对话模型不在同一个 `workbuddy-manager` 域名上，或者使用不同的密钥，可显式配置 `baseURL` 和 `apiKeyEnv`（显式配置优先级高于自动派生）：

```yaml
- insert:
    - id: web-search-workbuddy
      name: dsh-web-search-workbuddy
      config:
        baseURL: http://127.0.0.1:7864            # workbuddy-manager 根地址（不要带 /v1/tools/search）
        apiKeyEnv: WORKBUDDY_SEARCH_API_KEY       # DSH 凭据名或启动环境变量名（值为 wbk_...）
```

密钥解析顺序：优先从 DSH 凭据服务（`ctx.credentials`）读取 `apiKeyEnv` 对应的凭据，未找到时回退读取启动环境变量 `process.env[apiKeyEnv]`。

---

## 三、重启与生效验证

1. **完全重启 DSH**（修改 `cordis.patch.yml` 不支持热更新 HMR，重启后新建会话即可在工具列表看到 `web_search`）。
2. **命令行检查配置与兼容性**：
   ```bash
   # 检查默认搜索是否已禁用、搜索路由是否已切换为 workbuddy-gateway，且无 disabling / incompatible 告警
   dsh --profile web --dump-config | grep -A 3 -E "id: (web|web-search-deepseek|web-deepseek-api|web-search-workbuddy)$"
   ```
   正常应能看到：`web-search-deepseek` 与 `web-deepseek-api` 均带 `disabled: true`，`web` 下 `searchProvider: workbuddy-gateway`，且 `web-search-workbuddy` 指向 `dsh-web-search-workbuddy`。

---

## 四、全部配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseURL` | `string` | 自动派生 | `workbuddy-manager` 根地址（例如 `http://127.0.0.1:7864`）。省略时自动取当前模型路由 `baseURL` 并剥离末尾 `/v1/` |
| `apiKeyEnv` | `string` | 自动派生 | 凭据引用名 / 环境变量名（存放 `wbk_` 密钥）。省略时自动取当前模型路由的 `apiKeyEnv` |
| `timeoutMs` | `number` | `30000` | 单次搜索超时时间（毫秒，最小 `1000`；网关侧单账号上游超时上限为 20s） |
| `maxRetries` | `number` | `2` | 遇到瞬时网络错误、超时或 5xx（408/500/502/503/504）时的最大自动重试次数（`0..5`，`0` 表示不重试）；重试时会打印告警日志并在结果卡片标注重试次数 |
| `maxResults` | `number` | `5` | 默认最大返回条数（范围 `1..20`）；单次请求的 `maxResults` 优先 |
| `type` | `string` | `"text2text"` | agenttool 请求类型（`0057` 网关上游固定使用 `text2text`） |
| `allowedDomains` | `string[]` | 未设置 | 仅返回这些域名的结果（自动去除协议与路径并去重） |
| `blockedDomains` | `string[]` | 未设置 | 排除这些域名（网关按官方 CLI 语义拼接为 `-site:<domain>`） |
| `freshness` | `"d1" \| "m1" \| "y1"` | 未设置 | 时效过滤：`d1`（一天内）/ `m1`（一月内）/ `y1`（一年内） |
| `modelControlled` | `boolean` | `false` | 是否由本插件注册带过滤参数的 `web_search` 工具。设为 `true` 时须在所有 `tool-web` 中设 `search: false` |
| `modelMaxQueries` | `number` | `10` | `modelControlled: true` 时单次 `web_search` 最多允许的查询词条数（`1..10`） |
| `modelSummaryMaxChars` | `number` | `800` | `modelControlled: true` 时单条来源摘要的最大字符数（最小 `100`） |

---

## 五、前置依赖与兼容性要求

本插件**不是独立搜索引擎**，依赖 WorkBuddy 网关侧已合入 `/v1/tools/search` 透传补丁；若对接未打补丁的旧版本，会返回 `404`/`405`（路由不存在）或 `401`（鉴权失败）：

| 组件 | 版本 / 状态要求 | 说明 |
|---|---|---|
| **workbuddy-manager** | 需包含 `feat/web-search-passthrough` 路由（[PR #2](https://github.com/WaveBird/workbuddy-manager/pull/2)、[PR #3](https://github.com/WaveBird/workbuddy-manager/pull/3)，上游 [PR #430](https://github.com/ithtelab/workbuddy-manager/pull/430)）。基线已测：`v2.11.14` + 路由与完整参数校验提交（将在 `v2.11.14` 之后版本正式发布；在此之前请部署对应分支或 cherry-pick） | `<= v2.11.14` 上游版本没有 `POST /v1/tools/search` 路由，调用会返回 `405` |
| **workbuddy2api-go 网关** | 基于上游快照 `upstream-id 801cebba`（v2.11.14 / 0056 补丁）并打上 [`0057-web-search-tool.patch`](https://github.com/WaveBird/workbuddy-manager/blob/feat/web-search-passthrough/dev/upstream-patches/0057-web-search-tool.patch) | 负责 `/v1/tools/search` 处理、多账号池轮询以及 `15001` 额度耗尽冷却 |
| **DeepSeek Harness (DSH)** | `>=0.2.2-rc.1 <0.3.0-0`（已实测 `0.2.2-rc.1` 至 `0.2.2-rc.5`） | 依赖 `ctx.web.registerSearchProvider` / `WebSearchProvider` 契约，不跨 `0.3.0` |
| **CN / Global 双区** | 均支持。网关按账号所属区域自动路由（CN → `www.workbuddy.cn`，Global → `www.workbuddy.ai`）；本插件本身与区域无关，自动跟随当前会话路由 | 国际区账号同样参与账号池轮询与 `15001` 冷却 |

### 服务端连通性自检

```bash
# 1. 检查 workbuddy-manager 路由与完整参数透传（期望返回 200）
#    405/404 = manager 版本过旧无此路由；401 = wbk_ 密钥无效；400 = 未包含完整参数校验提交
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:7864/v1/tools/search \
  -H "Authorization: Bearer <你的 wbk_ 密钥>" \
  -H 'content-type: application/json' \
  -d '{"query":"ping","type":"text2text","max_results":3,"allowed_domains":["go.dev"],"blocked_domains":["reddit.com"],"freshness":"d1"}'

# 2. 直接检查 wb2api-go 网关存活（若配置了网关 api_key，期望返回 401 即代表路由存在）
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:7863/v1/tools/search \
  -H 'content-type: application/json' \
  -d '{"query":"ping"}'
```

---

## 六、零配置自动派生原理

当未显式填写 `baseURL` / `apiKeyEnv` 时，本插件会读取**当前发起搜索的会话正在使用的模型路由**（例如 `llm-pi-ai` 下的 `workbuddy-mannager-cn`）：

1. 通过与官方 `@deepseek-ai/dsh-web-deepseek-api` 相同的机制（`llm.listConfigurableProviders()` → `loader.entries()` → `effectiveConfig`）读取该路由配置；
2. 取出其中的 `apiKeyEnv` 解析密钥（`ctx.credentials` 优先，其次启动环境变量）；
3. 取出其中的 `baseURL` 并剥离末尾的 `/v1/` 后缀（聊天走 `/v1/chat/completions`，搜索走同源 `/v1/tools/search`）。

当你在会话中切换不同的 WorkBuddy 模型路由时，搜索请求会自动跟随当前路由的地址与密钥。

---

## 七、协议细节

### 请求格式

```http
POST {baseURL}/v1/tools/search
Authorization: Bearer <wbk_ key>
Content-Type: application/json
```

```json
{
  "query": "go generics",
  "type": "text2text",
  "max_results": 5,
  "allowed_domains": ["go.dev"],
  "blocked_domains": ["reddit.com"],
  "freshness": "d1"
}
```

| agenttool 字段 | 插件配置项 | 单次请求覆盖字段 | 取值与规则 |
|---|---|---|---|
| `query` | （来自请求） | `query` | 必填 |
| `type` | `type` | `type` | 默认 `"text2text"` |
| `max_results` | `maxResults` | `maxResults` / `max_results` | 钳制在 `1..20`，默认 `5` |
| `allowed_domains` | `allowedDomains` | `allowedDomains` / `allowed_domains` | 自动去协议/路径、去重；空数组省略 |
| `blocked_domains` | `blockedDomains` | `blockedDomains` / `blocked_domains` | 同上；空数组省略 |
| `freshness` | `freshness` | `freshness` | `d1` \| `m1` \| `y1`；未设置时省略；非法值在本地直接拦截报错，不消耗搜索额度 |

### 响应格式

上游返回 agenttool 标准信封，由本插件归一化为 DSH `ctx.web` 的 `{ sources: [{ url, title, snippet, summary }], truncated }` 结构（自动过滤非 `http(s)://` 链接并按 URL 去重）：

```json
{
  "code": 0,
  "msg": "",
  "results": [
    { "title": "...", "url": "https://...", "snippet": "..." }
  ],
  "total_results": 3,
  "response_time_ms": 616,
  "provider": "1"
}
```

---

## 八、错误码与常见问题排查

### 错误码表

| 场景 | `WebError` 错误码 |
|---|---|
| 无法派生且未配置 `baseURL` / `apiKeyEnv` | `WEB_PROVIDER_CONFIGURED_MISSING` |
| 未找到可用密钥（凭据服务与环境变量均为空） | `WEB_PROVIDER_CREDENTIAL_MISSING` |
| `workbuddy-manager` 不可达 / 非 2xx 响应 / 上游业务码 `code ≠ 0` | `WEB_PROVIDER_ERROR` |
| 账号池所有账号搜索额度耗尽（上游 `15001`，网关 HTTP `429` `quota_web_search`） | `WEB_PROVIDER_ERROR`（消息提示配额耗尽，次日重置） |
| 调用方主动取消 | `WEB_ABORTED` |
| 超过 `timeoutMs` 超时 | `WEB_PROVIDER_ERROR`（消息提示 timed out） |
| 单次请求传入非法 `freshness` | `WEB_PROVIDER_ERROR`（本地拦截，不发请求） |
| 配置项类型或范围非法 | 启动装配阶段由 Config Schema 直接拒绝 |

### 常见问题

- **提示 `configured web provider "workbuddy-gateway" is not registered`**：
  - 检查 `cordis.patch.yml` 中是否已 `- insert:` 了 `dsh-web-search-workbuddy`；
  - 确认已完全重启 DSH；
  - 若之前装的是 `<= 0.4.1` 旧版导致被 DSH 启动器因版本不兼容禁用，请升级至 `>= 0.4.2`（`dsh plugin --profile <name> add dsh-web-search-workbuddy@latest`）。
- **开启 `modelControlled: true` 后启动报错提示 `web_search` 重复注册**：
  - 请检查全局以及所有 agent preset 中的 `@deepseek-ai/dsh-tool-web` 配置，确保全部设置了 `search: false`。
- **搜索返回 HTTP 405 / 404**：
  - 当前 `workbuddy-manager` 版本未包含 `/v1/tools/search` 透传路由，请按「第五节」自检并更新 manager 与 `0057` 网关补丁。

---

## 开源协议

MIT — 各上游项目代码遵循其各自开源协议。
