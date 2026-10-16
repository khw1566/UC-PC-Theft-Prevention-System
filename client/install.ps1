<#
.SYNOPSIS
    PCGuard 클라이언트를 설치하고 작업 스케줄러에 등록합니다. 관리자 권한 PowerShell에서 실행하세요.

.EXAMPLE
    .\install.ps1 -ServerUrl https://pcguard.audreaming.com -ApiKey <발급받은 키>

.EXAMPLE
    .\install.ps1    # 같은 폴더의 config.json(배포 패키지에 들어 있음)에서 주소와 키를 읽습니다.
#>
[CmdletBinding()]
param(
    [string]$ServerUrl,
    [string]$ApiKey,
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

$packaged = Join-Path $PSScriptRoot 'config.json'
if ((-not $ServerUrl -or -not $ApiKey) -and (Test-Path $packaged)) {
    $cfg = Get-Content $packaged -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $ServerUrl) { $ServerUrl = $cfg.server_url }
    if (-not $ApiKey) { $ApiKey = $cfg.api_key }
}
if (-not $ServerUrl -or -not $ApiKey) {
    throw '-ServerUrl과 -ApiKey를 주거나 같은 폴더에 config.json을 두세요.'
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
'collect.ps1', 'menu.ps1', 'tray.ps1', 'uninstall.ps1' | ForEach-Object { Copy-Item (Join-Path $PSScriptRoot $_) $InstallDir -Force }

[ordered]@{ server_url = $ServerUrl; api_key = $ApiKey } |
    ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir 'config.json') -Encoding UTF8

# 학생 계정이 키를 읽거나 스크립트를 바꾸지 못하도록 관리자/SYSTEM만 접근하게 합니다.
# 언어별 계정 이름 차이를 피하려고 SID를 씁니다 (S-1-5-18 SYSTEM, S-1-5-32-544 Administrators).
icacls $InstallDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
# 작업표시줄 아이콘은 로그인한 사용자 권한으로 돌기 때문에 tray.ps1만 읽을 수 있게 합니다 (S-1-5-32-545 Users).
icacls (Join-Path $InstallDir 'tray.ps1') /grant '*S-1-5-32-545:RX' | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $env:ProgramData 'PCGuard') | Out-Null

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

# 시작 메뉴 바로가기. 관리자 권한으로만 열리게 해서 학생 계정은 UAC에서 막힙니다.
function New-AdminShortcut([string]$Name, [string]$Arguments, [string]$Icon) {
    $path = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\$Name.lnk"
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
    $lnk.TargetPath = 'powershell.exe'
    $lnk.Arguments = $Arguments
    $lnk.IconLocation = $Icon
    $lnk.Save()
    $bytes = [IO.File]::ReadAllBytes($path)
    $bytes[0x15] = $bytes[0x15] -bor 0x20   # '관리자 권한으로 실행' 플래그
    [IO.File]::WriteAllBytes($path, $bytes)
}
New-AdminShortcut 'PCGuard 관리 메뉴' "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'menu.ps1')`"" 'imageres.dll,-1028'
New-AdminShortcut 'PCGuard 제거' "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'uninstall.ps1')`"" 'imageres.dll,-5305'

# 작업표시줄 알림 영역 아이콘: 모든 사용자가 로그인할 때 시작합니다.
$trayLnk = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp\PCGuard.lnk'
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($trayLnk)
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'tray.ps1')`""
$lnk.IconLocation = 'imageres.dll,-1028'
$lnk.Save()

Write-Host "설치 완료: $InstallDir"
Write-Host "시작 메뉴에 'PCGuard 관리 메뉴'를 만들었어요 (테스트 알림, 메모, 기능 끄기)."
Write-Host "작업 '$TaskName' 등록됨 (부팅 시 + 매주 $WeeklyDay $WeeklyTime)"
Write-Host '첫 보고를 지금 보냅니다...'
$stateFile = Join-Path $env:ProgramData 'PCGuard\state.json'
Remove-Item $stateFile -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
for ($i = 0; $i -lt 60 -and -not (Test-Path $stateFile); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path $stateFile) {
    $state = Get-Content -Raw -Encoding UTF8 $stateFile | ConvertFrom-Json
    if ($state.ok) { Write-Host "첫 보고 성공 ($($state.detail)). 대시보드에서 이 PC를 확인하세요." }
    else { Write-Warning "첫 보고 실패: $($state.detail)" }
} else {
    Write-Warning "1분 안에 보고 결과가 없어요. $(Join-Path $env:ProgramData 'PCGuard\pcguard.log')를 확인하세요."
}

# 관리자 권한이 아닌 현재 사용자로 아이콘을 띄우려고 탐색기를 통해 바로가기를 엽니다.
Start-Process explorer.exe "`"$trayLnk`""
