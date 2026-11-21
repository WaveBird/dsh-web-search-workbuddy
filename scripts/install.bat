@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1

REM dsh-web-search-workbuddy 一键安装与配置脚本（Windows CMD 入口）
REM 支持双击运行，或在命令行传入参数：
REM   scripts\install.bat [--profile <name>] [--github] [--model-controlled] [--no-restart] [--skip-network-check]

set "PS_BIN="
where pwsh >nul 2>&1 && set "PS_BIN=pwsh"
if not defined PS_BIN (
  where powershell >nul 2>&1 && set "PS_BIN=powershell"
)
if not defined PS_BIN (
  echo [error] 前置检查未通过：未检测到 PowerShell ^(pwsh / powershell^)。
  echo   解决办法：请确认系统已启用 Windows PowerShell，或从 https://aka.ms/powershell 安装 PowerShell 7 后重试。
  set "EXIT_CODE=1"
  goto :finish
)

set "PS_ARGS="
:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--profile" (
  if "%~2"=="" (
    echo [error] --profile 需要指定 profile 名称
    set "EXIT_CODE=1"
    goto :finish
  )
  set "PS_ARGS=!PS_ARGS! -Profile "%~2""
  shift
  shift
  goto :parse_args
)
if /I "%~1"=="-Profile" (
  if "%~2"=="" (
    echo [error] -Profile 需要指定 profile 名称
    set "EXIT_CODE=1"
    goto :finish
  )
  set "PS_ARGS=!PS_ARGS! -Profile "%~2""
  shift
  shift
  goto :parse_args
)
if /I "%~1"=="--github" (
  set "PS_ARGS=!PS_ARGS! -Github"
  shift
  goto :parse_args
)
if /I "%~1"=="-Github" (
  set "PS_ARGS=!PS_ARGS! -Github"
  shift
  goto :parse_args
)
if /I "%~1"=="--model-controlled" (
  set "PS_ARGS=!PS_ARGS! -ModelControlled"
  shift
  goto :parse_args
)
if /I "%~1"=="-ModelControlled" (
  set "PS_ARGS=!PS_ARGS! -ModelControlled"
  shift
  goto :parse_args
)
if /I "%~1"=="--provider-only" (
  set "PS_ARGS=!PS_ARGS! -ProviderOnly"
  shift
  goto :parse_args
)
if /I "%~1"=="-ProviderOnly" (
  set "PS_ARGS=!PS_ARGS! -ProviderOnly"
  shift
  goto :parse_args
)
if /I "%~1"=="--pkg" (
  if "%~2"=="" (
    echo [error] --pkg 需要指定包来源
    set "EXIT_CODE=1"
    goto :finish
  )
  set "PS_ARGS=!PS_ARGS! -Pkg "%~2""
  shift
  shift
  goto :parse_args
)
if /I "%~1"=="-Pkg" (
  if "%~2"=="" (
    echo [error] -Pkg 需要指定包来源
    set "EXIT_CODE=1"
    goto :finish
  )
  set "PS_ARGS=!PS_ARGS! -Pkg "%~2""
  shift
  shift
  goto :parse_args
)
if /I "%~1"=="--no-restart" (
  set "PS_ARGS=!PS_ARGS! -NoRestart"
  shift
  goto :parse_args
)
if /I "%~1"=="-NoRestart" (
  set "PS_ARGS=!PS_ARGS! -NoRestart"
  shift
  goto :parse_args
)
if /I "%~1"=="--skip-network-check" (
  set "PS_ARGS=!PS_ARGS! -SkipNetworkCheck"
  shift
  goto :parse_args
)
if /I "%~1"=="-SkipNetworkCheck" (
  set "PS_ARGS=!PS_ARGS! -SkipNetworkCheck"
  shift
  goto :parse_args
)
if /I "%~1"=="-h" (
  set "PS_ARGS=!PS_ARGS! -Help"
  shift
  goto :parse_args
)
if /I "%~1"=="--help" (
  set "PS_ARGS=!PS_ARGS! -Help"
  shift
  goto :parse_args
)
if /I "%~1"=="-Help" (
  set "PS_ARGS=!PS_ARGS! -Help"
  shift
  goto :parse_args
)
echo [error] 未知参数: %~1（使用 --help 查看用法）
set "EXIT_CODE=1"
goto :finish

:args_done
set "LOCAL_PS1=%~dp0install.ps1"
set "CLEANUP_TMP="

if exist "%LOCAL_PS1%" (
  set "TARGET_PS1=%LOCAL_PS1%"
) else (
  set "TARGET_PS1=%TEMP%\dsh-web-search-workbuddy-install-%RANDOM%.ps1"
  set "CLEANUP_TMP=1"
  echo [info] 未在同目录发现 install.ps1，正在从 GitHub 拉取 scripts/install.ps1...
  "%PS_BIN%" -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/WaveBird/dsh-web-search-workbuddy/main/scripts/install.ps1' -OutFile '!TARGET_PS1!' } catch { Write-Error $_.Exception.Message; exit 1 }"
  if errorlevel 1 (
    echo [error] 前置检查未通过：无法从 GitHub 下载 scripts/install.ps1。
    echo   解决办法：请检查网络或代理设置，或完整克隆仓库后运行 scripts\install.bat。
    set "EXIT_CODE=1"
    goto :finish
  )
)

"%PS_BIN%" -NoProfile -ExecutionPolicy Bypass -File "%TARGET_PS1%" %PS_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"

if defined CLEANUP_TMP (
  del /f /q "%TARGET_PS1%" >nul 2>&1
)

:finish
REM 若通过双击运行（CMDCMDLINE 包含 /c），结束时暂停方便查看日志
echo %CMDCMDLINE% | find /i "/c" >nul 2>&1
if not errorlevel 1 (
  echo.
  pause
)
exit /b %EXIT_CODE%
