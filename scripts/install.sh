#!/usr/bin/env bash
set -euo pipefail

# dsh-web-search-workbuddy 一键安装与配置脚本（macOS / Linux）
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/WaveBird/dsh-web-search-workbuddy/main/scripts/install.sh | bash
#   ./scripts/install.sh [--profile <name>] [--github] [--model-controlled] [--no-restart] [--skip-network-check]

PKG_NPM="dsh-web-search-workbuddy@latest"
PKG_GITHUB="github:WaveBird/dsh-web-search-workbuddy#main"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

PROFILE=""
USE_GITHUB=0
CUSTOM_PKG=""
MODEL_CONTROLLED=1
NO_RESTART=0
SKIP_NETWORK_CHECK=0

usage() {
  cat <<'EOF'
dsh-web-search-workbuddy 一键安装与配置脚本（macOS / Linux）

用法:
  scripts/install.sh [选项]

选项:
  --profile <name>      指定目标 DSH profile（默认自动检测 ~/.dsh/profiles，仅有一个时自动选用）
  --github              从 GitHub main 分支安装，而非 npm 正式版
  --pkg <spec>          指定自定义包来源（例如 github:WaveBird/dsh-web-search-workbuddy#分支名 或本地路径）
  --model-controlled    启用 modelControlled: true（默认已开启，模型可见全部 5 个搜索参数）
  --provider-only       仅注册底层搜索 provider，保留官方 1 参数 web_search（modelControlled: false）
  --no-restart          完成安装和配置后不询问重启
  --skip-network-check  跳过安装前的在线源连通性预检
  -h, --help            显示此帮助信息
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      if [ $# -lt 2 ]; then
        echo "错误: --profile 需要指定 profile 名称" >&2
        exit 1
      fi
      PROFILE="$2"
      shift 2
      ;;
    --github)
      USE_GITHUB=1
      shift
      ;;
    --pkg)
      if [ $# -lt 2 ]; then
        echo "错误: --pkg 需要指定包名、GitHub 引用或路径" >&2
        exit 1
      fi
      CUSTOM_PKG="$2"
      shift 2
      ;;
    --model-controlled)
      MODEL_CONTROLLED=1
      shift
      ;;
    --provider-only)
      MODEL_CONTROLLED=0
      shift
      ;;
    --no-restart)
      NO_RESTART=1
      shift
      ;;
    --skip-network-check)
      SKIP_NETWORK_CHECK=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1（使用 --help 查看用法）" >&2
      exit 1
      ;;
  esac
done

info()  { printf '\033[1;34m[info]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

fail_with_guide() {
  local problem="$1"
  local solution="$2"
  err "前置检查未通过：$problem"
  printf '  \033[1;33m解决办法：\033[0m%s\n' "$solution" >&2
  exit 1
}

warn_with_guide() {
  local problem="$1"
  local solution="$2"
  warn "$problem"
  printf '  \033[1;33m建议处理：\033[0m%s\n' "$solution"
}

read_input() {
  local prompt="$1"
  local __var="$2"
  local val=""
  if [ -t 0 ]; then
    printf '%s' "$prompt"
    IFS= read -r val || true
  elif [ -r /dev/tty ]; then
    printf '%s' "$prompt" > /dev/tty
    IFS= read -r val < /dev/tty || true
  else
    val=""
  fi
  printf -v "$__var" '%s' "$val"
}

# =========================================================================
# 阶段 1：前置条件检测
# =========================================================================
info "步骤 1/5：检测安装前置条件..."

# 1.1 检测 Node.js >= 20
if ! command -v node >/dev/null 2>&1; then
  fail_with_guide \
    "未检测到 node 命令（本插件与 DSH 要求 Node.js >= 20）。" \
    "请先安装 Node.js 20+（macOS 可运行 brew install node，或前往 https://nodejs.org 下载 LTS 版本），安装后重新打开终端再执行本脚本。"
fi

NODE_VER_RAW="$(node -v 2>/dev/null || echo "")"
NODE_MAJOR="$(printf '%s' "$NODE_VER_RAW" | sed -E 's/^v?([0-9]+).*/\1/')"
if ! printf '%s' "$NODE_MAJOR" | grep -Eq '^[0-9]+$' || [ "$NODE_MAJOR" -lt 20 ]; then
  fail_with_guide \
    "当前 Node.js 版本为 ${NODE_VER_RAW:-未知}，低于最低要求 Node.js >= 20。" \
    "请升级 Node.js 至 20 LTS 或更高版本（例如 nvm install 20 && nvm use 20，或 brew upgrade node）后重试。"
fi
ok "Node.js 版本检查通过: $NODE_VER_RAW"

# 1.2 检测 dsh 命令
DSH_BIN=""
if command -v dsh >/dev/null 2>&1; then
  DSH_BIN="$(command -v dsh)"
elif [ -x "$HOME/.local/bin/dsh" ]; then
  DSH_BIN="$HOME/.local/bin/dsh"
elif [ -x "/usr/local/bin/dsh" ]; then
  DSH_BIN="/usr/local/bin/dsh"
elif [ -x "/opt/homebrew/bin/dsh" ]; then
  DSH_BIN="/opt/homebrew/bin/dsh"
else
  fail_with_guide \
    "未检测到 dsh 命令（已搜索 PATH、~/.local/bin、/usr/local/bin、/opt/homebrew/bin）。" \
    "请先安装 DeepSeek Harness（DSH），或将 dsh 所在目录加入 PATH（例如在 ~/.zshrc 中添加 export PATH=\"\$HOME/.local/bin:\$PATH\" 并执行 source ~/.zshrc）。"
fi

# 1.3 检测 dsh 版本是否在兼容范围 >=0.2.2-rc.1 <0.3.0-0
DSH_VERSION="$("$DSH_BIN" --version 2>/dev/null | head -n 1 | tr -d '\r' || echo "")"
if [ -z "$DSH_VERSION" ]; then
  fail_with_guide \
    "无法通过 $DSH_BIN --version 获取 DSH 版本号。" \
    "请确认 $DSH_BIN 可正常执行，必要时重新安装 DeepSeek Harness。"
fi

check_dsh_semver() {
  node - "$1" <<'NODE_EOF'
const v = (process.argv[2] || '').trim();
const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
if (!m) {
  console.log('INVALID');
  process.exit(0);
}
const major = Number(m[1]);
const minor = Number(m[2]);
const patch = Number(m[3]);
const pre = m[4] || '';

// 判断 >= 0.2.2-rc.1 && < 0.3.0-0（匹配 DSH includePrerelease 语义）
if (major !== 0 || minor !== 2) {
  console.log(major > 0 || minor >= 3 ? 'TOO_HIGH' : 'TOO_LOW');
  process.exit(0);
}
if (patch < 2) {
  console.log('TOO_LOW');
  process.exit(0);
}
if (patch === 2 && pre) {
  const parts = pre.split('.');
  const cmpId = (a, b) => {
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
    if (an && bn) return Number(a) - Number(b);
    if (an) return -1;
    if (bn) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const minPre = ['rc', '1'];
  let cmp = 0;
  for (let i = 0; i < Math.max(parts.length, minPre.length); i++) {
    if (i >= parts.length) { cmp = -1; break; }
    if (i >= minPre.length) { cmp = 1; break; }
    cmp = cmpId(parts[i], minPre[i]);
    if (cmp !== 0) break;
  }
  if (cmp < 0) {
    console.log('TOO_LOW');
    process.exit(0);
  }
}
console.log('OK');
NODE_EOF
}

DSH_VER_CHECK="$(check_dsh_semver "$DSH_VERSION")"

case "$DSH_VER_CHECK" in
  OK)
    ok "DSH 检查通过: $DSH_BIN (版本: $DSH_VERSION，满足 >=0.2.2-rc.1 <0.3.0-0)"
    ;;
  TOO_LOW)
    fail_with_guide \
      "当前 DSH 版本为 $DSH_VERSION，低于本插件最低要求 0.2.2-rc.1。" \
      "请先将 DeepSeek Harness 升级到 0.2.2-rc.1 及以上的 0.2.x 版本（推荐 0.2.2-rc.5+）后再运行本脚本。"
    ;;
  TOO_HIGH)
    fail_with_guide \
      "当前 DSH 版本为 $DSH_VERSION，超出了本插件声明的兼容上限 <0.3.0-0。" \
      "0.3.x 可能存在 web seam 破坏性变更，请查看 https://github.com/WaveBird/dsh-web-search-workbuddy 是否有适配新版本 DSH 的插件更新。"
    ;;
  *)
    warn_with_guide \
      "DSH 版本字符串 \"$DSH_VERSION\" 非标准 semver，无法自动校验兼容性。" \
      "脚本将继续执行；如后续被 DSH 启动器禁用，请确认 DSH 版本在 0.2.2-rc.1 ~ 0.2.x 范围内。"
    ;;
esac

# 1.4 若走 --github，检查 git 是否已安装
if [ "$USE_GITHUB" -eq 1 ] && ! command -v git >/dev/null 2>&1; then
  fail_with_guide \
    "指定了 --github 参数，但未检测到 git 命令。" \
    "请先安装 git（macOS 可运行 xcode-select --install 或 brew install git，Linux 可运行 apt/yum install git），或去掉 --github 参数改为从 npm 安装。"
fi

# 1.5 检测在线安装源连通性
if [ "$SKIP_NETWORK_CHECK" -eq 0 ]; then
  CHECK_URL="https://registry.npmjs.org/dsh-web-search-workbuddy"
  CHECK_LABEL="npm registry (registry.npmjs.org)"
  if [ "$USE_GITHUB" -eq 1 ]; then
    CHECK_URL="https://github.com/WaveBird/dsh-web-search-workbuddy"
    CHECK_LABEL="GitHub (github.com)"
  fi
  if ! node - "$CHECK_URL" <<'NODE_EOF'
const url = process.argv[2];
fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
  .then((res) => process.exit(res.ok || res.status < 500 ? 0 : 1))
  .catch(() => process.exit(1));
NODE_EOF
  then
    fail_with_guide \
      "无法连接到在线安装源 $CHECK_LABEL ($CHECK_URL)。" \
      "请检查本机网络、DNS 或代理设置（可先 export HTTPS_PROXY=http://127.0.0.1:<端口>）；若已配置内网 npm 镜像源，可加上 --skip-network-check 跳过预检重试。"
  fi
  ok "在线安装源连通性检查通过: $CHECK_LABEL"
fi

# =========================================================================
# 阶段 2：自动检测并选择 DSH profile
# =========================================================================
info "步骤 2/5：检测 DSH profile..."
PROFILES_DIR="$DSH_HOME/profiles"
if [ -z "$PROFILE" ]; then
  PROFILES=()
  if [ -d "$PROFILES_DIR" ]; then
    for entry in "$PROFILES_DIR"/*; do
      [ -d "$entry" ] || continue
      base="$(basename "$entry")"
      case "$base" in
        .*) continue ;;
      esac
      PROFILES+=("$base")
    done
  fi

  COUNT="${#PROFILES[@]}"
  if [ "$COUNT" -eq 1 ]; then
    PROFILE="${PROFILES[0]}"
    ok "检测到唯一 DSH profile: $PROFILE，将自动安装并配置。"
  elif [ "$COUNT" -gt 1 ]; then
    echo "检测到多个 DSH profile："
    idx=1
    for p in "${PROFILES[@]}"; do
      echo "  $idx) $p"
      idx=$((idx + 1))
    done
    choice=""
    read_input "请选择要安装的 profile 编号 [默认 1]: " choice
    if [ -z "$choice" ]; then
      choice=1
    fi
    if ! printf '%s' "$choice" | grep -Eq '^[0-9]+$' || [ "$choice" -lt 1 ] || [ "$choice" -gt "$COUNT" ]; then
      fail_with_guide \
        "无效的 profile 编号: $choice（可选范围 1..$COUNT）。" \
        "请重新运行脚本并输入列表中的数字，或直接通过 --profile <名称> 指定。"
    fi
    PROFILE="${PROFILES[$((choice - 1))]}"
    ok "已选择 profile: $PROFILE"
  else
    warn_with_guide \
      "未在 $PROFILES_DIR 下发现已初始化的 DSH profile。" \
      "可直接输入一个 profile 名称（默认 web），dsh plugin 会首次自动初始化；也可以先运行一次 dsh web 或打开 DSH 桌面版后再执行本脚本。"
    read_input "请输入要初始化并安装的 profile 名称 [默认 web]: " PROFILE
    if [ -z "$PROFILE" ]; then
      PROFILE="web"
    fi
    info "将使用 profile: $PROFILE"
  fi
else
  info "使用指定 profile: $PROFILE"
fi

PROFILE_DIR="$PROFILES_DIR/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

# 检测目录权限
if ! mkdir -p "$PROFILE_DIR" 2>/dev/null || [ ! -w "$PROFILE_DIR" ]; then
  fail_with_guide \
    "目标 profile 目录不可写: $PROFILE_DIR。" \
    "请检查目录权限或所有者（例如运行 ls -ld \"$PROFILE_DIR\"，必要时修复权限 chown -R \"\$(id -un)\" \"$DSH_HOME\"）后重试。"
fi

probe_gateway_route() {
  node - "$1" <<'NODE_EOF'
const fs = require('node:fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
const hasPiAi = /@deepseek-ai\/dsh-llm-pi-ai|id:\s*['"]?llm-pi-ai['"]?/.test(text);
if (!hasPiAi) {
  console.log('NO_ROUTE');
  process.exit(0);
}
const m = text.match(/^\s*baseURL:\s*['"]?(https?:\/\/[^\s'"]+)['"]?/m);
if (!m) {
  console.log('NO_BASEURL');
  process.exit(0);
}
const origin = m[1].replace(/\/v1\/?$/, '').replace(/\/+$/, '');
const target = `${origin}/v1/tools/search`;
fetch(target, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'ping' }),
  signal: AbortSignal.timeout(3000),
}).then((res) => {
  console.log(`HTTP:${res.status}:${target}`);
}).catch((e) => {
  console.log(`UNREACHABLE:${target}:${e.message || e}`);
});
NODE_EOF
}

# 2.1 预检现有路由与 workbuddy-manager 连通性（非阻断提示）
if [ -f "$PATCH_FILE" ]; then
  GATEWAY_CHECK="$(probe_gateway_route "$PATCH_FILE")"
  case "$GATEWAY_CHECK" in
    NO_ROUTE)
      warn_with_guide \
        "在 $PATCH_FILE 中未检测到 llm-pi-ai 模型路由配置。" \
        "默认零配置模式依赖当前对话的模型路由自动派生网关地址和 wbk_ 密钥；请确认已在 DSH 中配置 workbuddy-manager 模型路由，或在 web-search-workbuddy.config 中显式配置 baseURL 与 apiKeyEnv。"
      ;;
    NO_BASEURL)
      warn_with_guide \
        "检测到 llm-pi-ai 配置，但未发现有效的 baseURL。" \
        "请确认模型路由已配置 workbuddy-manager 地址（如 http://127.0.0.1:7864/v1/），否则搜索会报 WEB_PROVIDER_CONFIGURED_MISSING。"
      ;;
    HTTP:404:*|HTTP:405:*)
      GW_URL="${GATEWAY_CHECK#HTTP:???:}"
      warn_with_guide \
        "探测到 $GW_URL 返回 404/405，当前 workbuddy-manager 可能未包含 /v1/tools/search 透传路由。" \
        "请将 workbuddy-manager 升级至包含 PR #2 / PR #3（v2.11.14 之后版本或 feat/web-search-passthrough 分支），并确认 wb2api-go 已打 0057-web-search-tool.patch。"
      ;;
    HTTP:200:*|HTTP:400:*|HTTP:401:*)
      GW_URL="${GATEWAY_CHECK#HTTP:???:}"
      ok "workbuddy-manager 搜索路由探测正常 ($GW_URL 响应可达)"
      ;;
    UNREACHABLE:*)
      GW_URL="$(printf '%s' "$GATEWAY_CHECK" | cut -d: -f2-3)"
      warn_with_guide \
        "暂无法连接到 $GW_URL（workbuddy-manager 可能尚未启动或端口不同）。" \
        "请在使用 web_search 前确认 workbuddy-manager 与 wb2api-go 网关已启动；如果搜索网关与聊天地址不同，请在 cordis.patch.yml 中显式配置 baseURL。"
      ;;
  esac
else
  warn_with_guide \
    "尚未存在 $PATCH_FILE，脚本将为你创建新配置。" \
    "如果你尚未配置 workbuddy-manager 模型路由，请在安装完成后在 DSH 设置中配置模型路由，或在 web-search-workbuddy.config 中显式指定 baseURL 与 apiKeyEnv。"
fi

# =========================================================================
# 阶段 3：通过 dsh plugin add 在线安装插件
# =========================================================================
PKG_SPEC="$PKG_NPM"
if [ -n "$CUSTOM_PKG" ]; then
  PKG_SPEC="$CUSTOM_PKG"
elif [ "$USE_GITHUB" -eq 1 ]; then
  PKG_SPEC="$PKG_GITHUB"
fi

info "步骤 3/5：正在安装插件 ($DSH_BIN plugin --profile $PROFILE add $PKG_SPEC)..."
if ! "$DSH_BIN" plugin --profile "$PROFILE" add "$PKG_SPEC"; then
  fail_with_guide \
    "执行 \"$DSH_BIN plugin --profile $PROFILE add $PKG_SPEC\" 失败。" \
    "常见原因：1) 网络或代理无法访问 npm/GitHub；2) DSH 版本与插件 peerDependencies 不匹配；3) profile 目录下 pnpm 锁文件异常。请查看上方报错，或尝试配置代理 / 加上 --github 重试。"
fi
ok "插件安装完成。"

# =========================================================================
# 阶段 4：备份并更新 cordis.patch.yml + 校验配置
# =========================================================================
info "步骤 4/5：更新并校验 $PATCH_FILE（关闭默认 DSH 搜索并切换为 workbuddy-gateway）..."

BACKUP_FILE=""
if [ -f "$PATCH_FILE" ]; then
  BACKUP_FILE="${PATCH_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  cp "$PATCH_FILE" "$BACKUP_FILE"
  info "已备份原配置至: $BACKUP_FILE"
fi

node - "$PATCH_FILE" "$MODEL_CONTROLLED" <<'NODE_EOF'
const fs = require('node:fs');

const patchFile = process.argv[2];
const modelControlled = process.argv[3] === '1';

const START_MARKER = '# >>> dsh-web-search-workbuddy (managed by install.sh) >>>';
const END_MARKER = '# <<< dsh-web-search-workbuddy <<<';

let content = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';

const startIdx = content.indexOf(START_MARKER);
const endIdx = content.indexOf(END_MARKER);
if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
  const before = content.slice(0, startIdx).replace(/\n+$/, '');
  const after = content.slice(endIdx + END_MARKER.length).replace(/^\n+/, '');
  content = [before, after].filter(Boolean).join('\n\n');
}

const hasManualInsert = /^\s*-?\s*id:\s*['"]?web-search-workbuddy['"]?\s*$/m.test(content);

const pluginLines = hasManualInsert
  ? [
      '- id: web-search-workbuddy',
      '  name: dsh-web-search-workbuddy',
      ...(modelControlled ? ['  config:', '    modelControlled: true'] : []),
    ]
  : [
      '- insert:',
      '    - id: web-search-workbuddy',
      '      name: dsh-web-search-workbuddy',
      ...(modelControlled ? ['      config:', '        modelControlled: true'] : []),
    ];

const blockLines = [
  START_MARKER,
  '# 关闭 DSH 默认的 DeepSeek 搜索提供器与设置页',
  '- id: web-search-deepseek',
  '  disabled: true',
  '- id: web-deepseek-api',
  '  disabled: true',
  '- id: ui-settings-web-search',
  '  disabled: true',
  '# 注册 WorkBuddy 搜索插件',
  ...pluginLines,
  '# 将 DSH 搜索提供器切换为 workbuddy-gateway（保留 http 供 web_fetch 使用）',
  '- id: web',
  "  name: '@deepseek-ai/dsh-web'",
  '  config:',
  '    fetchProvider: http',
  '    searchProvider: workbuddy-gateway',
  '# 配置 tool-web 工具入口',
  '- id: tool-web',
  "  name: '@deepseek-ai/dsh-tool-web'",
  '  config:',
  '    fetch: true',
  `    search: ${modelControlled ? 'false' : 'true'}`,
  '    searchTimeoutMs: 60000',
  END_MARKER,
];

const block = blockLines.join('\n');
const trimmed = content.trimEnd();
const next = trimmed.length > 0
  ? `${trimmed}\n\n${block}\n`
  : `# DSH profile patch layer\n${block}\n`;

fs.writeFileSync(patchFile, next, 'utf8');
NODE_EOF

DUMP_OUT=""
if ! DUMP_OUT="$("$DSH_BIN" --profile "$PROFILE" --dump-config 2>&1)"; then
  err "DSH 配置校验失败，正在自动回滚原配置..."
  if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
    cp "$BACKUP_FILE" "$PATCH_FILE"
    warn "已恢复原配置: $PATCH_FILE"
  fi
  printf '%s\n' "$DUMP_OUT" >&2
  fail_with_guide \
    "执行 \"$DSH_BIN --profile $PROFILE --dump-config\" 返回非零退出码。" \
    "请检查上方 YAML 报错（可能是原 cordis.patch.yml 存在语法问题），修复后再重新运行本脚本。"
fi

if printf '%s\n' "$DUMP_OUT" | grep -Eq 'disabling profile plugin.*web-search-workbuddy|dsh-web-search-workbuddy.*incompatible'; then
  printf '%s\n' "$DUMP_OUT" | grep -E 'disabling profile plugin|incompatible' >&2 || true
  fail_with_guide \
    "DSH 兼容性校验拒绝了 dsh-web-search-workbuddy（启动器会将其禁用）。" \
    "请确认已安装 >= 0.4.2 版本的插件，且 DSH 版本在 >=0.2.2-rc.1 <0.3.0-0 范围内。"
fi

ok "配置校验通过：已关闭默认 DSH 搜索并切换至 workbuddy-gateway。"
if [ "$MODEL_CONTROLLED" -eq 1 ]; then
  ok "已开启 modelControlled: true（模型可自主使用 queries / allowedDomains / blockedDomains / freshness / maxResults 全部 5 个参数）。"
fi

# =========================================================================
# 阶段 5：检测运行中的 DSH 进程并询问是否重启（回车确认）
# =========================================================================
info "步骤 5/5：检测是否需要重启 DSH..."

find_running_dsh() {
  node - "$PROFILE" "$$" <<'NODE_EOF'
const { execFileSync } = require('node:child_process');
const profile = process.argv[2];
const selfPid = Number(process.argv[3]);

let out = '';
try {
  out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
} catch {
  process.exit(0);
}

const matches = [];
for (const line of out.split('\n')) {
  const m = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!m) continue;
  const pid = Number(m[1]);
  const cmd = m[2].trim();
  if (!pid || pid === selfPid || pid === process.pid) continue;
  if (!/(^|[\s/])dsh(\s|$)/.test(cmd)) continue;
  if (/\bdsh\s+plugin\b|--dump-config|install\.sh/.test(cmd)) continue;
  const reSub = new RegExp(`(^|[\\s/])dsh\\s+(--profile\\s+)?${profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  if (reSub.test(cmd)) {
    matches.push({ pid, cmd });
  }
}

for (const item of matches) {
  console.log(`${item.pid}\t${item.cmd}`);
}
NODE_EOF
}

RUNNING_LIST="$(find_running_dsh || true)"

if [ -n "$RUNNING_LIST" ]; then
  echo ""
  warn "修改 cordis.patch.yml 需要重启 DSH（profile: $PROFILE）后才能生效。"
  echo "检测到正在运行的 DSH 进程："
  while IFS=$'\t' read -r pid cmd; do
    [ -n "$pid" ] || continue
    echo "  PID $pid: $cmd"
  done <<< "$RUNNING_LIST"

  if [ "$NO_RESTART" -eq 1 ]; then
    info "已指定 --no-restart，跳过自动重启。请稍后手动重启 DSH。"
    exit 0
  fi

  confirm=""
  read_input "是否立即重启以上 DSH 进程？[Y/n]（直接按回车确认重启，输入 n 跳过）: " confirm
  confirm_lower="$(printf '%s' "$confirm" | tr '[:upper:]' '[:lower:]')"

  if [ -z "$confirm_lower" ] || [ "$confirm_lower" = "y" ] || [ "$confirm_lower" = "yes" ]; then
    PRIMARY_CMD=""
    PIDS_TO_KILL=()
    while IFS=$'\t' read -r pid cmd; do
      [ -n "$pid" ] || continue
      PIDS_TO_KILL+=("$pid")
      if [ -z "$PRIMARY_CMD" ]; then
        PRIMARY_CMD="$cmd"
      fi
    done <<< "$RUNNING_LIST"

    info "正在停止旧的 DSH 进程..."
    for pid in "${PIDS_TO_KILL[@]}"; do
      kill "$pid" 2>/dev/null || true
    done

    waited=0
    while [ "$waited" -lt 16 ]; do
      still_alive=0
      for pid in "${PIDS_TO_KILL[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
          still_alive=1
        fi
      done
      if [ "$still_alive" -eq 0 ]; then
        break
      fi
      sleep 0.5
      waited=$((waited + 1))
    done

    sleep 1
    AFTER_LIST="$(find_running_dsh || true)"
    if [ -n "$AFTER_LIST" ]; then
      ok "检测到系统守护进程已自动重新拉起 DSH："
      while IFS=$'\t' read -r pid cmd; do
        [ -n "$pid" ] || continue
        echo "  PID $pid: $cmd"
      done <<< "$AFTER_LIST"
    else
      LOG_FILE="$PROFILE_DIR/dsh-restart.log"
      info "正在按原启动参数重新启动 DSH..."
      nohup sh -c "exec $PRIMARY_CMD" >> "$LOG_FILE" 2>&1 < /dev/null &
      NEW_PID=$!
      sleep 2
      AFTER_LIST="$(find_running_dsh || true)"
      if kill -0 "$NEW_PID" 2>/dev/null || [ -n "$AFTER_LIST" ]; then
        ok "DSH 已重启（PID: $NEW_PID，日志: $LOG_FILE）。请新建会话使用 web_search。"
      else
        warn_with_guide \
          "后台重启进程未能持续运行，请查看日志: $LOG_FILE。" \
          "请在终端手动重新启动：$PRIMARY_CMD"
      fi
    fi
  else
    info "已跳过重启。请稍后手动重启 DSH（profile: $PROFILE）使配置生效。"
  fi
else
  echo ""
  ok "全部完成！未检测到正在运行的 DSH（profile: $PROFILE）进程，下次启动 dsh $PROFILE 即自动生效。"
fi
