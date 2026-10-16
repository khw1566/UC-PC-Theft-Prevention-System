<#
.SYNOPSIS
    PCGuard 클라이언트를 설치하고 작업 스케줄러에 등록합니다. 관리자 권한 PowerShell에서 실행하세요.

.EXAMPLE
    .\install.ps1 -ServerUrl https://pcguard.audreaming.com -ApiKey <발급받은 키>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$ServerUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'PCGuard'),
    [ValidateSet('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')]
    [string]$WeeklyDay = 'Monday',
    [string]$WeeklyTime = '09:00'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'PCGuard Hardware Check'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '관리자 권한으로 실행해야 합니다.'
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'collect.ps1') $InstallDir -Force

[ordered]@{ server_url = $ServerUrl; api_key = $ApiKey } |
    ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir 'config.json') -Encoding UTF8

# 학생 계정이 키를 읽거나 스크립트를 바꾸지 못하도록 관리자/SYSTEM만 접근하게 합니다.
icacls $InstallDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null

$script = Join-Path $InstallDir 'collect.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""

# 부팅 직후엔 네트워크가 늦게 잡히므로 2분 지연합니다.
$atStartup = New-ScheduledTaskTrigger -AtStartup
$atStartup.Delay = 'PT2M'
$weekly = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $WeeklyDay -At $WeeklyTime

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
$runAs = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $atStartup, $weekly `
    -Settings $settings -Principal $runAs -Force | Out-Null

Write-Host "설치 완료: $InstallDir"
Write-Host "작업 '$TaskName' 등록됨 (부팅 시 + 매주 $WeeklyDay $WeeklyTime)"
Write-Host '첫 보고를 지금 보냅니다...'
Start-ScheduledTask -TaskName $TaskName
