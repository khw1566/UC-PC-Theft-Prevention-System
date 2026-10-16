[CmdletBinding()]
param([string]$InstallDir = (Join-Path $env:ProgramFiles 'PCGuard'))

$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName 'PCGuard Hardware Check' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\PCGuard 관리 메뉴.lnk') -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp\PCGuard.lnk') -ErrorAction SilentlyContinue
# 실행 중인 작업표시줄 아이콘(tray.ps1)을 닫습니다.
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like '*PCGuard\tray.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $env:ProgramData 'PCGuard') -ErrorAction SilentlyContinue
Write-Host 'PCGuard 제거 완료'
