# 一键安装 / 卸载 dsh-ofm-compat（Windows 薄包装）
#
# 真正的逻辑只有一份，在 scripts/cli.mjs（跨平台）。
# 本脚本只是为了让你不必关心 node 细节。
#
# 用法：
#   .\scripts\install.ps1                     # 装进 desktop profile（WeChatAgent 用的那个）
#   .\scripts\install.ps1 -Profile web
#   .\scripts\install.ps1 -Spec github:you/dsh-ofm-compat
#   .\scripts\install.ps1 -DryRun
#   .\scripts\install.ps1 -Uninstall
#   .\scripts\install.ps1 -Command doctor     # 环境体检
#   .\scripts\install.ps1 -Command status     # 读取运行状态

[CmdletBinding()]
param(
    [ValidateSet('install', 'uninstall', 'status', 'doctor')]
    [string]$Command = 'install',
    [string]$Profile = 'desktop',
    [string]$Spec = '',
    [string]$DshHome = '',
    [int]$Port = 0,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\cli.mjs'
if (-not (Test-Path $cli)) {
    Write-Host "找不到 $cli" -ForegroundColor Red
    exit 2
}

# 注意：不能给 $args 赋值（PowerShell 自动变量），所以这里叫 $nodeArgs
$nodeArgs = @($cli, $Command, '--profile', $Profile)
if ($Spec) { $nodeArgs += @('--spec', $Spec) }
if ($DshHome) { $nodeArgs += @('--dsh-home', $DshHome) }
if ($Port -gt 0) { $nodeArgs += @('--port', "$Port") }
if ($DryRun) { $nodeArgs += '--dry-run' }
if ($Force) { $nodeArgs += '--force-manual' }

& node @nodeArgs
exit $LASTEXITCODE
