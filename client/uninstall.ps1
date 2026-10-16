[CmdletBinding()]
param([string]$InstallDir = (Join-Path $env:ProgramFiles 'PCGuard'))

$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName 'PCGuard Hardware Check' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $env:ProgramData 'PCGuard') -ErrorAction SilentlyContinue
Write-Host 'PCGuard 제거 완료'
