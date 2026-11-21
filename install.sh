#!/usr/bin/env bash
set -euo pipefail

# dsh-web-search-workbuddy 一键安装与配置脚本
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/WaveBird/dsh-web-search-workbuddy/main/install.sh | bash
#   ./install.sh [--profile <name>] [--github] [--model-controlled] [--no-restart]

PKG_NPM="dsh-web-search-workbuddy@latest"
PKG_GITHUB="github:WaveBird/dsh-web-search-workbuddy#main"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

PROFILE=""
USE_GITHUB=0
MODEL_CONTROLLED=0
NO_RESTART=0

usage() {
  cat <<'EOF'
dsh-web-search-workbuddy 一键安装与配置脚本

用法:
  install.sh [选项]

选项:
  --profile <name>    指定目标 DSH profile（默认自动检测 ~/.dsh/profiles，仅有一个时自动选用）
  --github            从 GitHub main 分支安装，而非 npm 正式版
  --model-controlled  启用 modelControlled: true（模型自主控制搜索过滤参数）
  --no-restart        完成安装和配置后不询问重启
  -h, --help          显示此帮助信息
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
    --model-controlled)
      MODEL_CONTROLLED=1
      shift
      ;;
    --no-restart)
      NO_RESTART=1
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

# 1. 查找 dsh 与 node
DSH_BIN=""
if command -v dsh >/dev/null 2>&1; then
  DSH_BIN="$(command -v dsh)"
elif [ -x "$HOME/.local/bin/dsh" ]; then
  DSH_BIN="$HOME/.local/bin/dsh"
else
  err "未找到 dsh 命令，请先安装 DeepSeek Harness 或将 dsh 加入 PATH。"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  err "未找到 node 命令（需要 Node.js >= 20）。"
  exit 1
fi

DSH_VERSION="$("$DSH_BIN" --version 2>/dev/null || echo "unknown")"
info "检测到 DSH: $DSH_BIN (版本: $DSH_VERSION)"

# 2. 自动检测 DSH profile
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
    info "检测到唯一 DSH profile: $PROFILE，自动选用并继续安装配置。"
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
      err "无效选择: $choice"
      exit 1
    fi
    PROFILE="${PROFILES[$((choice - 1))]}"
    info "已选择 profile: $PROFILE"
  else
    warn "未在 $PROFILES_DIR 下发现已初始化的 profile。"
    read_input "请输入要初始化并安装的 profile 名称 [默认 web]: " PROFILE
    if [ -z "$PROFILE" ]; then
      PROFILE="web"
    fi
    info "将使用 profile: $PROFILE"
  fi
else
  info "使用指定 profile: $PROFILE"
fi

# 3. 通过 dsh plugin add 在线安装插件
PKG_SPEC="$PKG_NPM"
if [ "$USE_GITHUB" -eq 1 ]; then
  PKG_SPEC="$PKG_GITHUB"
fi

info "正在安装插件: $DSH_BIN plugin --profile $PROFILE add $PKG_SPEC"
"$DSH_BIN" plugin --profile "$PROFILE" add "$PKG_SPEC"
ok "插件安装完成。"

# 4. 安全更新 cordis.patch.yml（关闭默认 DSH 搜索并切换为 workbuddy-gateway）
PROFILE_DIR="$PROFILES_DIR/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
mkdir -p "$PROFILE_DIR"

BACKUP_FILE=""
if [ -f "$PATCH_FILE" ]; then
  BACKUP_FILE="${PATCH_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  cp "$PATCH_FILE" "$BACKUP_FILE"
  info "已备份原配置至: $BACKUP_FILE"
fi

info "正在更新配置: $PATCH_FILE"
node - "$PATCH_FILE" "$MODEL_CONTROLLED" <<'NODE_EOF'
const fs = require('node:fs');

const patchFile = process.argv[2];
const modelControlled = process.argv[3] === '1';

const START_MARKER = '# >>> dsh-web-search-workbuddy (managed by install.sh) >>>';
const END_MARKER = '# <<< dsh-web-search-workbuddy <<<';

let content = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';

// 移除旧的托管块（保证重复执行幂等）
const startIdx = content.indexOf(START_MARKER);
const endIdx = content.indexOf(END_MARKER);
if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
  const before = content.slice(0, startIdx).replace(/\n+$/, '');
  const after = content.slice(endIdx + END_MARKER.length).replace(/^\n+/, '');
  content = [before, after].filter(Boolean).join('\n\n');
}

// 检查托管块之外是否已手动插入过 web-search-workbuddy，避免重复 insert 同名 id
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

# 5. 使用 dsh --dump-config 验证配置与兼容性；失败则自动回滚备份
info "正在校验 DSH 配置与插件兼容性..."
DUMP_OUT=""
if ! DUMP_OUT="$("$DSH_BIN" --profile "$PROFILE" --dump-config 2>&1)"; then
  err "DSH 配置校验失败，正在回滚配置..."
  if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
    cp "$BACKUP_FILE" "$PATCH_FILE"
    warn "已恢复原配置: $PATCH_FILE"
  fi
  printf '%s\n' "$DUMP_OUT" >&2
  exit 1
fi

if printf '%s\n' "$DUMP_OUT" | grep -Eq 'disabling profile plugin.*web-search-workbuddy|dsh-web-search-workbuddy.*incompatible'; then
  err "检测到 DSH 兼容性校验拒绝了 dsh-web-search-workbuddy："
  printf '%s\n' "$DUMP_OUT" | grep -E 'disabling profile plugin|incompatible' >&2 || true
  exit 1
fi

ok "配置校验通过：已关闭默认 DSH 搜索并切换至 workbuddy-gateway。"
if [ "$MODEL_CONTROLLED" -eq 1 ]; then
  warn "已开启 modelControlled: true；如果你还启用了自定义 agent preset，请确认其中 tool-web 也已设置 search: false。"
fi

# 6. 检测运行中的 DSH 进程并询问是否重启（回车确认）
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
  // 匹配 dsh 启动进程，排除 dsh plugin / install.sh / --dump-config 等临时命令
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

    # 等待旧进程退出（最多 8 秒）
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

    # 如果被 launchd/systemd 等守护进程自动拉起，则不再重复启动
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
        warn "后台启动似乎已退出，请查看日志: $LOG_FILE，或手动执行："
        echo "  $PRIMARY_CMD"
      fi
    fi
  else
    info "已跳过重启。请稍后手动重启 DSH（profile: $PROFILE）使配置生效。"
  fi
else
  echo ""
  ok "全部完成！未检测到正在运行的 DSH（profile: $PROFILE）进程，下次启动 dsh $PROFILE 即自动生效。"
fi
