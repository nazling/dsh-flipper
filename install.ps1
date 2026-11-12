# 把当前仓库安装到 DSH profile，并复制到 dsh-go 插件目录。
# 用法：.\install.ps1
# 可选：$env:DSH_HOME、$env:DSH_PROFILE
$ErrorActionPreference = 'Stop'

$Src = Split-Path -Parent $MyInvocation.MyCommand.Path
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$Profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }
$Dest = Join-Path $DshHome 'dsh-go\plugins\dsh-flipper'

if (-not (Test-Path (Join-Path $Src 'package.json'))) {
    throw 'install.ps1 必须在仓库根目录运行（找不到 package.json）'
}

Write-Host "安装到 $Dest"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dest) | Out-Null
if ($Src -ne $Dest) {
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    Copy-Item -Recurse -Force $Src $Dest
    Remove-Item -Recurse -Force (Join-Path $Dest '.git') -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force (Join-Path $Dest 'node_modules') -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force (Join-Path $Dest 'android\build') -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force (Join-Path $Dest 'android\.gradle') -ErrorAction SilentlyContinue
}

dsh plugin --profile $Profile add $Dest
Write-Host ''
Write-Host '已安装。请重启 DSH 引擎（设置 → 引擎 → 重启引擎）。'
Write-Host '手机用户记得安装 Android BLE 桥 APK：dist/flipper-ble-bridge-1.6.apk'
