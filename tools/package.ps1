<#
.SYNOPSIS
    배포 패키지를 dist/에 만듭니다.
    - PCGuard-Client.zip: 학교 PC용. 압축을 풀고 install.bat을 더블클릭하면 설치됩니다.
    - PCGuard.apk: 관리자 휴대폰용 앱.

.DESCRIPTION
    클라이언트 키는 -ApiKey로 주거나, 없으면 worker/pcguard-keys.local.txt의 PCGUARD_API_KEY를 씁니다.
    관리자 키는 PC 패키지에 넣지 않습니다. dist/는 키가 들어 있으므로 git에 올리지 않습니다.

.EXAMPLE
    .\tools\package.ps1
    .\tools\package.ps1 -BuildApk    # APK도 새로 빌드 (JDK 17~21 필요)
#>
[CmdletBinding()]
param(
    [string]$ServerUrl = 'https://pcguard.audreaming.com',
    [string]$ApiKey,
    [switch]$BuildApk
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'PCGuard-Client'

if (-not $ApiKey) {
    $keys = Join-Path $root 'worker\pcguard-keys.local.txt'
    if (-not (Test-Path $keys)) { throw "-ApiKey를 주거나 $keys 를 만들어 두세요." }
    $line = Get-Content $keys | Where-Object { $_ -like 'PCGUARD_API_KEY=*' } | Select-Object -First 1
    if (-not $line) { throw "$keys 에 PCGUARD_API_KEY가 없습니다." }
    $ApiKey = $line.Substring('PCGUARD_API_KEY='.Length).Trim()
}

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$client = Join-Path $root 'client'
'collect.ps1', 'menu.ps1', 'tray.ps1', 'install.ps1', 'uninstall.ps1', 'install.bat', 'uninstall.bat' |
    ForEach-Object { Copy-Item (Join-Path $client $_) $stage }

$utf8 = New-Object Text.UTF8Encoding($false)
$config = [ordered]@{ server_url = $ServerUrl; api_key = $ApiKey } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $stage 'config.json'), $config, $utf8)

$readme = @"
PCGuard 학교 PC 설치 패키지

설치: install.bat을 더블클릭하고 관리자 권한을 허용하세요.
  - C:\Program Files\PCGuard에 설치되고, 부팅 2분 후와 매주 월요일 09:00에 하드웨어 정보를 보냅니다.
  - 시작 메뉴에 'PCGuard 관리 메뉴'가 생깁니다 (상태 확인, 테스트 알림, 메모, 기능 끄기).
  - 작업표시줄 알림 영역에 PCGuard 방패 아이콘이 뜹니다. 우클릭하면 상태 보기, 지금 보고, 관리 메뉴가 있습니다.
    안 보이면 작업표시줄 오른쪽의 ^ 를 눌러 아이콘을 작업표시줄로 끌어다 놓으세요.
  - 요일/시간 변경은 관리자 PowerShell에서 .\install.ps1 -WeeklyDay Friday -WeeklyTime 16:00
제거: uninstall.bat을 더블클릭하세요.

서버: $ServerUrl
config.json에 클라이언트 키가 들어 있으니 학교 PC 설치용으로만 쓰세요.
"@
[IO.File]::WriteAllText((Join-Path $stage 'README.txt'), $readme, $utf8)

$zip = Join-Path $dist 'PCGuard-Client.zip'
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Write-Host "PC 패키지: $zip"

$android = Join-Path $root 'android'
$apk = Join-Path $android 'app\build\outputs\apk\release\app-release.apk'
if ($BuildApk) {
    Push-Location $android
    try { & .\gradlew.bat assembleRelease; if ($LASTEXITCODE) { throw 'APK 빌드 실패' } } finally { Pop-Location }
}
if (Test-Path $apk) {
    Copy-Item $apk (Join-Path $dist 'PCGuard.apk') -Force
    Write-Host "휴대폰 앱: $(Join-Path $dist 'PCGuard.apk')"
} else {
    Write-Warning 'APK가 없습니다. -BuildApk로 다시 실행하세요.'
}
