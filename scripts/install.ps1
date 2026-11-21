<#
.SYNOPSIS
  dsh-web-search-workbuddy 一键安装与配置脚本（Windows PowerShell 5.1 / 7+）

.DESCRIPTION
  自动检测前置条件与 DSH profile（仅有一个时自动选用），通过 dsh plugin add 在线安装插件，
  关闭 DSH 默认搜索并切换为 workbuddy-gateway，校验通过后检测运行中的 DSH 进程并询问是否重启。

.EXAMPLE
  irm https://raw.githubusercontent.com/WaveBird/dsh-web-search-workbuddy/main/scripts/install.ps1 | iex
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile desktop
#>
[CmdletBinding()]
param(
  [string]$Profile = "",
  [switch]$Github,
  [switch]$ModelControlled,
  [switch]$NoRestart,
  [switch]$SkipNetworkCheck,
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
  # 非交互宿主环境下忽略编码设置错误
}

$PkgNpm = "dsh-web-search-workbuddy@latest"
$PkgGithub = "github:WaveBird/dsh-web-search-workbuddy#main"
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }

function Show-Usage {
  Write-Host @"
dsh-web-search-workbuddy 一键安装与配置脚本（Windows PowerShell）

用法:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 [选项]

选项:
  -Profile <name>      指定目标 DSH profile（默认自动检测 %USERPROFILE%\.dsh\profiles，仅有一个时自动选用）
  -Github              从 GitHub main 分支安装，而非 npm 正式版
  -ModelControlled     启用 modelControlled: true（模型自主控制搜索过滤参数）
  -NoRestart           完成安装和配置后不询问重启
  -SkipNetworkCheck    跳过安装前的在线源连通性预检
  -Help                显示此帮助信息
"@
}

if ($Help) {
  Show-Usage
  exit 0
}

function Write-Info([string]$Msg) { Write-Host "[info] $Msg" -ForegroundColor Cyan }
function Write-Ok([string]$Msg)   { Write-Host "[ok] $Msg" -ForegroundColor Green }
function Write-Warn([string]$Msg) { Write-Host "[warn] $Msg" -ForegroundColor Yellow }
function Write-Err([string]$Msg)  { Write-Host "[error] $Msg" -ForegroundColor Red }

function Fail-WithGuide([string]$Problem, [string]$Solution) {
  Write-Err "前置检查未通过：$Problem"
  Write-Host "  解决办法：$Solution" -ForegroundColor Yellow
  exit 1
}

function Warn-WithGuide([string]$Problem, [string]$Solution) {
  Write-Warn $Problem
  Write-Host "  建议处理：$Solution" -ForegroundColor Yellow
}

function Invoke-NodeScript([string]$Code, [string[]]$ScriptArgs = @()) {
  $tmpFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "dsh-wb-install-" + [System.Guid]::NewGuid().ToString("N") + ".cjs")
  try {
    [System.IO.File]::WriteAllText($tmpFile, $Code, (New-Object System.Text.UTF8Encoding($false)))
    $allArgs = @($tmpFile) + $ScriptArgs
    $out = & node @allArgs 2>&1
    $codeExit = $LASTEXITCODE
    return @{ ExitCode = $codeExit; Output = ($out -join "`n").Trim() }
  } finally {
    if (Test-Path -LiteralPath $tmpFile) {
      Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
    }
  }
}

# =========================================================================
# 阶段 1：前置条件检测
# =========================================================================
Write-Info "步骤 1/5：检测安装前置条件..."

# 1.1 检测 Node.js >= 20
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Fail-WithGuide `
    "未检测到 node 命令（本插件与 DSH 要求 Node.js >= 20）。" `
    "请先安装 Node.js 20+（可运行 winget install OpenJS.NodeJS.LTS，或前往 https://nodejs.org 下载 LTS 安装包），安装后重开终端再执行本脚本。"
}

$nodeVerRaw = (& node -v 2>$null | Select-Object -First 1)
if ($null -eq $nodeVerRaw) { $nodeVerRaw = "" }
$nodeVerRaw = $nodeVerRaw.Trim()
$nodeMajor = 0
if ($nodeVerRaw -match '^v?(\d+)') {
  $nodeMajor = [int]$Matches[1]
}
if ($nodeMajor -lt 20) {
  Fail-WithGuide `
    "当前 Node.js 版本为 '$nodeVerRaw'，低于最低要求 Node.js >= 20。" `
    "请升级 Node.js 至 20 LTS 或更高版本（winget upgrade OpenJS.NodeJS.LTS 或前往 https://nodejs.org 下载）后重试。"
}
Write-Ok "Node.js 版本检查通过: $nodeVerRaw"

# 1.2 检测 dsh 命令
$DshBin = $null
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
  $DshBin = $dshCmd.Source
} else {
  $candidates = @(
    (Join-Path $env:USERPROFILE ".local\bin\dsh.exe"),
    (Join-Path $env:USERPROFILE ".local\bin\dsh.cmd"),
    (Join-Path $env:APPDATA "npm\dsh.cmd"),
    (Join-Path $env:LOCALAPPDATA "Programs\dsh\dsh.exe")
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) {
      $DshBin = $c
      break
    }
  }
}

if (-not $DshBin) {
  Fail-WithGuide `
    "未检测到 dsh 命令（已搜索 PATH、%USERPROFILE%\.local\bin、%APPDATA%\npm、%LOCALAPPDATA%\Programs\dsh）。" `
    "请先安装 DeepSeek Harness（DSH），并确认 dsh.exe / dsh.cmd 所在目录已加入系统环境变量 PATH 后重开终端重试。"
}

# 1.3 检测 dsh 版本是否在兼容范围 >=0.2.2-rc.1 <0.3.0-0
$DshVersion = (& $DshBin --version 2>$null | Select-Object -First 1)
if ($null -eq $DshVersion) { $DshVersion = "" }
$DshVersion = $DshVersion.Trim()
if ([string]::IsNullOrWhiteSpace($DshVersion)) {
  Fail-WithGuide `
    "无法通过 '$DshBin --version' 获取 DSH 版本号。" `
    "请确认 '$DshBin' 可正常执行，必要时重新安装 DeepSeek Harness。"
}

$verCheckCode = @'
const v = (process.argv[2] || '').trim();
const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
if (!m) { console.log('INVALID'); process.exit(0); }
const major = Number(m[1]), minor = Number(m[2]), patch = Number(m[3]), pre = m[4] || '';
if (major !== 0 || minor !== 2) { console.log(major > 0 || minor >= 3 ? 'TOO_HIGH' : 'TOO_LOW'); process.exit(0); }
if (patch < 2) { console.log('TOO_LOW'); process.exit(0); }
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
  if (cmp < 0) { console.log('TOO_LOW'); process.exit(0); }
}
console.log('OK');
'@
$verCheckRes = Invoke-NodeScript -Code $verCheckCode -ScriptArgs @($DshVersion)
switch ($verCheckRes.Output) {
  "OK" {
    Write-Ok "DSH 检查通过: $DshBin (版本: $DshVersion，满足 >=0.2.2-rc.1 <0.3.0-0)"
  }
  "TOO_LOW" {
    Fail-WithGuide `
      "当前 DSH 版本为 $DshVersion，低于本插件最低要求 0.2.2-rc.1。" `
      "请先将 DeepSeek Harness 升级到 0.2.2-rc.1 及以上的 0.2.x 版本（推荐 0.2.2-rc.5+）后再运行本脚本。"
  }
  "TOO_HIGH" {
    Fail-WithGuide `
      "当前 DSH 版本为 $DshVersion，超出了本插件声明的兼容上限 <0.3.0-0。" `
      "0.3.x 可能存在 web seam 破坏性变更，请查看 https://github.com/WaveBird/dsh-web-search-workbuddy 是否有适配新版本 DSH 的插件更新。"
  }
  default {
    Warn-WithGuide `
      "DSH 版本字符串 '$DshVersion' 非标准 semver，无法自动校验兼容性。" `
      "脚本将继续执行；如后续被 DSH 启动器禁用，请确认 DSH 版本在 0.2.2-rc.1 ~ 0.2.x 范围内。"
  }
}

# 1.4 若走 -Github，检查 git 是否已安装
if ($Github -and -not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail-WithGuide `
    "指定了 -Github 参数，但未检测到 git 命令。" `
    "请先安装 Git（winget install Git.Git 或前往 https://git-scm.com 下载），或去掉 -Github 参数改为从 npm 安装。"
}

# 1.5 检测在线安装源连通性
if (-not $SkipNetworkCheck) {
  $checkUrl = if ($Github) { "https://github.com/WaveBird/dsh-web-search-workbuddy" } else { "https://registry.npmjs.org/dsh-web-search-workbuddy" }
  $checkLabel = if ($Github) { "GitHub (github.com)" } else { "npm registry (registry.npmjs.org)" }
  $netCode = @'
const url = process.argv[2];
fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
  .then((res) => process.exit(res.ok || res.status < 500 ? 0 : 1))
  .catch(() => process.exit(1));
'@
  $netRes = Invoke-NodeScript -Code $netCode -ScriptArgs @($checkUrl)
  if ($netRes.ExitCode -ne 0) {
    Fail-WithGuide `
      "无法连接到在线安装源 $checkLabel ($checkUrl)。" `
      "请检查本机网络、DNS 或代理设置（例如 `$env:HTTPS_PROXY='http://127.0.0.1:<端口>'）；若已配置内网 npm 镜像源，可加上 -SkipNetworkCheck 跳过预检重试。"
  }
  Write-Ok "在线安装源连通性检查通过: $checkLabel"
}

# =========================================================================
# 阶段 2：自动检测并选择 DSH profile
# =========================================================================
Write-Info "步骤 2/5：检测 DSH profile..."
$ProfilesDir = Join-Path $DshHome "profiles"

if ([string]::IsNullOrWhiteSpace($Profile)) {
  $profiles = @()
  if (Test-Path -LiteralPath $ProfilesDir) {
    $profiles = @(Get-ChildItem -LiteralPath $ProfilesDir -Directory -ErrorAction SilentlyContinue | Where-Object { -not $_.Name.StartsWith(".") } | Select-Object -ExpandProperty Name)
  }

  if ($profiles.Count -eq 1) {
    $Profile = $profiles[0]
    Write-Ok "检测到唯一 DSH profile: $Profile，将自动安装并配置。"
  } elseif ($profiles.Count -gt 1) {
    Write-Host "检测到多个 DSH profile："
    for ($i = 0; $i -lt $profiles.Count; $i++) {
      Write-Host ("  {0}) {1}" -f ($i + 1), $profiles[$i])
    }
    $choice = Read-Host "请选择要安装的 profile 编号 [默认 1]"
    if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "1" }
    $choiceNum = 0
    if (-not [int]::TryParse($choice.Trim(), [ref]$choiceNum) -or $choiceNum -lt 1 -or $choiceNum -gt $profiles.Count) {
      Fail-WithGuide `
        "无效的 profile 编号: $choice（可选范围 1..$($profiles.Count)）。" `
        "请重新运行脚本并输入列表中的数字，或通过 -Profile <名称> 直接指定。"
    }
    $Profile = $profiles[$choiceNum - 1]
    Write-Ok "已选择 profile: $Profile"
  } else {
    Warn-WithGuide `
      "未在 $ProfilesDir 下发现已初始化的 DSH profile。" `
      "可直接输入一个 profile 名称（Windows 桌面版常用 desktop，Web 版常用 web），dsh plugin 会首次自动初始化；也可以先启动一次 DSH 后再运行本脚本。"
    $Profile = Read-Host "请输入要初始化并安装的 profile 名称 [默认 desktop]"
    if ([string]::IsNullOrWhiteSpace($Profile)) { $Profile = "desktop" }
    $Profile = $Profile.Trim()
    Write-Info "将使用 profile: $Profile"
  }
} else {
  Write-Info "使用指定 profile: $Profile"
}

$ProfileDir = Join-Path $ProfilesDir $Profile
$PatchFile = Join-Path $ProfileDir "cordis.patch.yml"

try {
  if (-not (Test-Path -LiteralPath $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
  }
  $probeFile = Join-Path $ProfileDir (".write-test-" + [System.Guid]::NewGuid().ToString("N"))
  [System.IO.File]::WriteAllText($probeFile, "ok")
  Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue
} catch {
  Fail-WithGuide `
    "目标 profile 目录不可写: $ProfileDir（$($_.Exception.Message)）。" `
    "请检查目录权限，或关闭占用该目录的程序后以当前用户身份重试。"
}

# 2.1 预检现有路由与 workbuddy-manager 连通性（非阻断提示）
if (Test-Path -LiteralPath $PatchFile) {
  $gwCheckCode = @'
const fs = require('node:fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
const hasPiAi = /@deepseek-ai\/dsh-llm-pi-ai|id:\s*['"]?llm-pi-ai['"]?/.test(text);
if (!hasPiAi) { console.log('NO_ROUTE'); process.exit(0); }
const m = text.match(/^\s*baseURL:\s*['"]?(https?:\/\/[^\s'"]+)['"]?/m);
if (!m) { console.log('NO_BASEURL'); process.exit(0); }
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
'@
  $gwRes = Invoke-NodeScript -Code $gwCheckCode -ScriptArgs @($PatchFile)
  $gwOut = $gwRes.Output
  if ($gwOut -eq "NO_ROUTE") {
    Warn-WithGuide `
      "在 $PatchFile 中未检测到 llm-pi-ai 模型路由配置。" `
      "默认零配置模式依赖当前对话的模型路由自动派生网关地址和 wbk_ 密钥；请确认已在 DSH 中配置 workbuddy-manager 模型路由，或在 web-search-workbuddy.config 中显式配置 baseURL 与 apiKeyEnv。"
  } elseif ($gwOut -eq "NO_BASEURL") {
    Warn-WithGuide `
      "检测到 llm-pi-ai 配置，但未发现有效的 baseURL。" `
      "请确认模型路由已配置 workbuddy-manager 地址（如 http://127.0.0.1:7864/v1/），否则搜索会报 WEB_PROVIDER_CONFIGURED_MISSING。"
  } elseif ($gwOut -match '^HTTP:(404|405):(.+)$') {
    Warn-WithGuide `
      "探测到 $($Matches[2]) 返回 $($Matches[1])，当前 workbuddy-manager 可能未包含 /v1/tools/search 透传路由。" `
      "请将 workbuddy-manager 升级至包含 PR #2 / PR #3（v2.11.14 之后版本或 feat/web-search-passthrough 分支），并确认 wb2api-go 已打 0057-web-search-tool.patch。"
  } elseif ($gwOut -match '^HTTP:(200|400|401):(.+)$') {
    Write-Ok "workbuddy-manager 搜索路由探测正常 ($($Matches[2]) 响应可达)"
  } elseif ($gwOut -match '^UNREACHABLE:(https?://[^:]+(?::\d+)?/[^:]*):') {
    Warn-WithGuide `
      "暂无法连接到 $($Matches[1])（workbuddy-manager 可能尚未启动或端口不同）。" `
      "请在使用 web_search 前确认 workbuddy-manager 与 wb2api-go 网关已启动；如果搜索网关与聊天地址不同，请在 cordis.patch.yml 中显式配置 baseURL。"
  }
} else {
  Warn-WithGuide `
    "尚未存在 $PatchFile，脚本将为你创建新配置。" `
    "如果你尚未配置 workbuddy-manager 模型路由，请在安装完成后在 DSH 设置中配置模型路由，或在 web-search-workbuddy.config 中显式指定 baseURL 与 apiKeyEnv。"
}

# =========================================================================
# 阶段 3：通过 dsh plugin add 在线安装插件
# =========================================================================
$PkgSpec = if ($Github) { $PkgGithub } else { $PkgNpm }
Write-Info "步骤 3/5：正在安装插件 ($DshBin plugin --profile $Profile add $PkgSpec)..."
& $DshBin plugin --profile $Profile add $PkgSpec
if ($LASTEXITCODE -ne 0) {
  Fail-WithGuide `
    "执行 '$DshBin plugin --profile $Profile add $PkgSpec' 失败（退出码: $LASTEXITCODE）。" `
    "常见原因：1) 网络或代理无法访问 npm/GitHub；2) DSH 版本与插件 peerDependencies 不匹配；3) profile 目录下 pnpm 锁文件异常。请查看上方报错，或配置代理 / 加上 -Github 重试。"
}
Write-Ok "插件安装完成。"

# =========================================================================
# 阶段 4：备份并更新 cordis.patch.yml + 校验配置
# =========================================================================
Write-Info "步骤 4/5：更新并校验 $PatchFile（关闭默认 DSH 搜索并切换为 workbuddy-gateway）..."

$BackupFile = $null
if (Test-Path -LiteralPath $PatchFile) {
  $ts = Get-Date -Format "yyyyMMddHHmmss"
  $BackupFile = "$PatchFile.bak.$ts"
  Copy-Item -LiteralPath $PatchFile -Destination $BackupFile -Force
  Write-Info "已备份原配置至: $BackupFile"
}

$patchCode = @'
const fs = require('node:fs');
const patchFile = process.argv[2];
const modelControlled = process.argv[3] === '1';

const START_MARKER = '# >>> dsh-web-search-workbuddy (managed by install.sh) >>>';
const END_MARKER = '# <<< dsh-web-search-workbuddy <<<';

let content = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
content = content.replace(/\r\n/g, '\n');

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
'@

$mcFlag = if ($ModelControlled) { "1" } else { "0" }
$patchRes = Invoke-NodeScript -Code $patchCode -ScriptArgs @($PatchFile, $mcFlag)
if ($patchRes.ExitCode -ne 0) {
  if ($BackupFile -and (Test-Path -LiteralPath $BackupFile)) {
    Copy-Item -LiteralPath $BackupFile -Destination $PatchFile -Force
  }
  Fail-WithGuide `
    "写入 $PatchFile 失败：$($patchRes.Output)" `
    "请检查文件是否被其他程序锁定或无写入权限。"
}

$dumpOutput = (& $DshBin --profile $Profile --dump-config 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
  Write-Err "DSH 配置校验失败，正在自动回滚原配置..."
  if ($BackupFile -and (Test-Path -LiteralPath $BackupFile)) {
    Copy-Item -LiteralPath $BackupFile -Destination $PatchFile -Force
    Write-Warn "已恢复原配置: $PatchFile"
  }
  Write-Host $dumpOutput
  Fail-WithGuide `
    "执行 '$DshBin --profile $Profile --dump-config' 返回非零退出码。" `
    "请检查上方 YAML 报错（可能是原 cordis.patch.yml 存在语法问题），修复后再重新运行本脚本。"
}

if ($dumpOutput -match 'disabling profile plugin.*web-search-workbuddy|dsh-web-search-workbuddy.*incompatible') {
  Write-Host ($dumpOutput -split "`n" | Where-Object { $_ -match 'disabling profile plugin|incompatible' } | Out-String)
  Fail-WithGuide `
    "DSH 兼容性校验拒绝了 dsh-web-search-workbuddy（启动器会将其禁用）。" `
    "请确认已安装 >= 0.4.2 版本的插件，且 DSH 版本在 >=0.2.2-rc.1 <0.3.0-0 范围内。"
}

Write-Ok "配置校验通过：已关闭默认 DSH 搜索并切换至 workbuddy-gateway。"
if ($ModelControlled) {
  Warn-WithGuide `
    "已开启 modelControlled: true。" `
    "如果你还启用了自定义 agent preset，请确认其中 @deepseek-ai/dsh-tool-web 也已设置 search: false，避免 web_search 重复注册。"
}

# =========================================================================
# 阶段 5：检测运行中的 DSH 进程并询问是否重启（回车确认）
# =========================================================================
Write-Info "步骤 5/5：检测是否需要重启 DSH..."

function Get-RunningDshProcesses([string]$TargetProfile) {
  $escaped = [regex]::Escape($TargetProfile)
  $pattern = "(^|[\s/\\`"'])dsh(\.exe|\.cmd)?[\`"']?\s+(--profile\s+)?$escaped(\s|$)"
  $procs = @()
  try {
    $all = Get-CimInstance Win32_Process -ErrorAction Stop
  } catch {
    $all = Get-WmiObject Win32_Process -ErrorAction SilentlyContinue
  }
  foreach ($p in $all) {
    if ($null -eq $p.CommandLine) { continue }
    if ($p.ProcessId -eq $PID) { continue }
    $cmd = [string]$p.CommandLine
    if ($cmd -match '\bdsh(\.exe|\.cmd)?\s+plugin\b|--dump-config|install\.ps1|install\.bat') { continue }
    if ($cmd -match $pattern) {
      $procs += [PSCustomObject]@{
        Pid = [int]$p.ProcessId
        CommandLine = $cmd
        ExecutablePath = [string]$p.ExecutablePath
      }
    }
  }
  return $procs
}

$running = @(Get-RunningDshProcesses -TargetProfile $Profile)
if ($running.Count -gt 0) {
  Write-Host ""
  Write-Warn "修改 cordis.patch.yml 需要重启 DSH（profile: $Profile）后才能生效。"
  Write-Host "检测到正在运行的 DSH 进程："
  foreach ($r in $running) {
    Write-Host ("  PID {0}: {1}" -f $r.Pid, $r.CommandLine)
  }

  if ($NoRestart) {
    Write-Info "已指定 -NoRestart，跳过自动重启。请稍后手动重启 DSH。"
    exit 0
  }

  $confirm = Read-Host "是否立即重启以上 DSH 进程？[Y/n]（直接按回车确认重启，输入 n 跳过）"
  $confirmLower = if ($null -eq $confirm) { "" } else { $confirm.Trim().ToLowerInvariant() }
  if ($confirmLower -eq "" -or $confirmLower -eq "y" -or $confirmLower -eq "yes") {
    $primary = $running[0]
    Write-Info "正在停止旧的 DSH 进程..."
    foreach ($r in $running) {
      Stop-Process -Id $r.Pid -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    foreach ($r in $running) {
      if (Get-Process -Id $r.Pid -ErrorAction SilentlyContinue) {
        Stop-Process -Id $r.Pid -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Seconds 1

    $after = @(Get-RunningDshProcesses -TargetProfile $Profile)
    if ($after.Count -gt 0) {
      Write-Ok "检测到服务管理器已自动重新拉起 DSH（PID: $($after[0].Pid)）。"
    } else {
      $logFile = Join-Path $ProfileDir "dsh-restart.log"
      Write-Info "正在按原启动参数重新启动 DSH..."
      try {
        Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "$($primary.CommandLine) >> `"$logFile`" 2>&1") -WindowStyle Hidden
        Start-Sleep -Seconds 2
        $restarted = @(Get-RunningDshProcesses -TargetProfile $Profile)
        if ($restarted.Count -gt 0) {
          Write-Ok "DSH 已重启（PID: $($restarted[0].Pid)，日志: $logFile）。请新建会话使用 web_search。"
        } else {
          Warn-WithGuide `
            "后台重启后未检测到新进程，请查看日志: $logFile。" `
            "请手动重新启动 DSH（如为桌面版请直接重新打开 DSH 应用，命令行版可运行: $($primary.CommandLine)）。"
        }
      } catch {
        Warn-WithGuide `
          "自动重启失败：$($_.Exception.Message)" `
          "请手动重新启动 DSH（profile: $Profile）。"
      }
    }
  } else {
    Write-Info "已跳过重启。请稍后手动重启 DSH（profile: $Profile）使配置生效。"
  }
} else {
  Write-Host ""
  Write-Ok "全部完成！未检测到正在运行的 DSH（profile: $Profile）进程，下次启动 dsh $Profile（或重新打开 DSH 桌面版）即自动生效。"
}
