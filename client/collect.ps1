<#
.SYNOPSIS
    PC 하드웨어 정보를 수집해 감시 서버로 전송합니다.

.DESCRIPTION
    Windows 시작 시(그리고 매주) 작업 스케줄러가 SYSTEM 권한으로 실행합니다.
    전송에 실패하면 보고서를 로컬 큐에 저장했다가 다음 실행 때 다시 보냅니다.
    Windows PowerShell 5.1 이상에서 동작합니다.
#>
[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$DataDir  = Join-Path $env:ProgramData 'PCGuard'
$QueueDir = Join-Path $DataDir 'queue'
$LogFile  = Join-Path $DataDir 'pcguard.log'
New-Item -ItemType Directory -Force -Path $QueueDir | Out-Null

function Write-Log([string]$Message) {
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Verbose $line
}

function Clean([object]$Value) {
    if ($null -eq $Value) { return $null }
    $s = "$Value".Trim()
    # 제조사가 비워 두는 자리표시 값은 식별자로 쓸 수 없으므로 버립니다.
    if ($s -eq '' -or $s -match '^(To be filled by O\.E\.M\.|Default string|System Serial Number|None|0+)$') { return $null }
    return $s
}

function Get-HardwareReport {
    $product = Get-CimInstance Win32_ComputerSystemProduct
    $board   = Get-CimInstance Win32_BaseBoard
    $bios    = Get-CimInstance Win32_BIOS
    $os      = Get-CimInstance Win32_OperatingSystem

    $components = @()

    foreach ($cpu in Get-CimInstance Win32_Processor) {
        $components += [ordered]@{
            kind = 'cpu'; key = (Clean $cpu.ProcessorId); model = (Clean $cpu.Name)
            detail = "$($cpu.NumberOfCores)C/$($cpu.NumberOfLogicalProcessors)T"
        }
    }
    foreach ($ram in Get-CimInstance Win32_PhysicalMemory) {
        $components += [ordered]@{
            kind = 'ram'; key = (Clean $ram.SerialNumber); model = (Clean $ram.PartNumber)
            detail = "$([math]::Round($ram.Capacity / 1GB)) GB @ $($ram.DeviceLocator)"
        }
    }
    foreach ($disk in Get-CimInstance Win32_DiskDrive | Where-Object { $_.InterfaceType -ne 'USB' }) {
        $components += [ordered]@{
            kind = 'disk'; key = (Clean $disk.SerialNumber); model = (Clean $disk.Model)
            detail = "$([math]::Round($disk.Size / 1GB)) GB"
        }
    }
    foreach ($gpu in Get-CimInstance Win32_VideoController) {
        $components += [ordered]@{
            kind = 'gpu'; key = (Clean $gpu.PNPDeviceID); model = (Clean $gpu.Name)
            detail = "$([math]::Round($gpu.AdapterRAM / 1MB)) MB"
        }
    }
    foreach ($nic in Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter = TRUE' | Where-Object { $_.MACAddress -and $_.PNPDeviceID -notmatch '^(ROOT|SWD)\\' }) {
        $components += [ordered]@{
            kind = 'nic'; key = (Clean $nic.MACAddress); model = (Clean $nic.Name); detail = $null
        }
    }

    [ordered]@{
        machine_id    = (Clean $product.UUID)
        hostname      = $env:COMPUTERNAME
        collected_at  = (Get-Date).ToUniversalTime().ToString('o')
        board_serial  = (Clean $board.SerialNumber)
        bios_serial   = (Clean $bios.SerialNumber)
        manufacturer  = (Clean $product.Vendor)
        product       = (Clean $product.Name)
        os            = "$($os.Caption) $($os.Version)"
        components    = $components
        client_version = '0.1.0'
    }
}

function Send-Report([string]$Json, $Config) {
    $headers = @{ 'X-Api-Key' = $Config.api_key }
    $uri = $Config.server_url.TrimEnd('/') + '/api/report'
    $body = [Text.Encoding]::UTF8.GetBytes($Json)
    Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body `
        -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
}

$config = Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json
$report = Get-HardwareReport
if (-not $report.machine_id) { $report.machine_id = $report.board_serial }
if (-not $report.machine_id) { $report.machine_id = $report.hostname }
$json = $report | ConvertTo-Json -Depth 5

if ($DryRun) { $json; return }

# 이번 보고서를 큐에 넣고, 쌓여 있던 것까지 오래된 순서로 전송합니다.
$queued = Join-Path $QueueDir ('{0:yyyyMMddHHmmss}.json' -f (Get-Date))
Set-Content -Path $queued -Value $json -Encoding UTF8

foreach ($file in Get-ChildItem $QueueDir -Filter *.json | Sort-Object Name) {
    try {
        $result = Send-Report (Get-Content -Raw -Encoding UTF8 $file.FullName) $config
        Remove-Item $file.FullName
        Write-Log "sent $($file.Name): status=$($result.status) alerts=$($result.alerts.Count)"
    } catch {
        Write-Log "send failed for $($file.Name): $($_.Exception.Message)"
        break
    }
}

# 큐가 무한히 커지지 않도록 최근 50개만 유지합니다.
Get-ChildItem $QueueDir -Filter *.json | Sort-Object Name -Descending |
    Select-Object -Skip 50 | Remove-Item -ErrorAction SilentlyContinue
