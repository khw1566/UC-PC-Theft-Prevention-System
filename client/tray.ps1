<#
.SYNOPSIS
    PCGuard 작업표시줄 아이콘. 로그인한 사용자 세션에서 알림 영역에 상주하며 마지막 보고 상태를 보여 주고,
    대시보드에서 '이 PC 화면에 식별 창 띄우기'를 누르면 화면에 눈에 띄는 창을 띄웁니다.

.DESCRIPTION
    보고 자체는 작업 스케줄러(SYSTEM)가 하고, 이 아이콘은 C:\ProgramData\PCGuard\state.json만 읽습니다.
    키가 든 config.json은 읽지 않으므로 학생 계정으로 실행돼도 안전합니다.
    식별 요청은 1분마다 서버의 /api/identify에 이 PC의 machine_id로 물어봅니다.
    관리 메뉴와 '지금 보고 보내기'는 관리자 권한(UAC)을 요청합니다.
#>
[CmdletBinding()]
param()

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 사용자마다 아이콘은 하나만 띄웁니다.
$created = $false
$mutex = New-Object Threading.Mutex($true, 'Local\PCGuardTray', [ref]$created)
if (-not $created) { return }

$InstallDir = $PSScriptRoot
$DataDir    = Join-Path $env:ProgramData 'PCGuard'
$StateFile  = Join-Path $DataDir 'state.json'
$TaskName   = 'PCGuard Hardware Check'
$UserLog    = Join-Path $env:LOCALAPPDATA 'PCGuard\tray.log'
$PollMs     = 60000

function Write-TrayLog([string]$Message) {
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path $UserLog) | Out-Null
        Add-Content -Path $UserLog -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message) -Encoding UTF8
    } catch { }
}

function Read-State {
    try { Get-Content -Raw -Encoding UTF8 $StateFile -ErrorAction Stop | ConvertFrom-Json } catch { $null }
}

function Format-Time($Iso) {
    if (-not $Iso) { return '없음' }
    try { ([datetime]$Iso).ToString('yyyy-MM-dd HH:mm') } catch { "$Iso" }
}

function Get-Summary {
    $s = Read-State
    if (-not $s) { return @{ Ok = $null; Text = '아직 보고 기록이 없어요' } }
    $ok = [bool]$s.ok
    $text = if ($ok) { "정상, 마지막 보고 $(Format-Time $s.last_success)" }
            else { "전송 실패 (대기 $($s.queued)건), 마지막 성공 $(Format-Time $s.last_success)" }
    @{ Ok = $ok; Text = $text; State = $s }
}

function Start-Elevated([string[]]$Arguments) {
    try {
        Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList $Arguments
    } catch {
        # UAC에서 '아니요'를 누른 경우
    }
}

# PCGuard 아이콘 (설치 폴더의 pcguard.png). 없으면 Windows 방패 아이콘을 씁니다.
function New-AppIcon {
    $png = Join-Path $InstallDir 'pcguard.png'
    try {
        $bmp = New-Object Drawing.Bitmap((New-Object Drawing.Bitmap($png)), 32, 32)
        return [Drawing.Icon]::FromHandle($bmp.GetHicon())
    } catch {
        return [Drawing.SystemIcons]::Shield
    }
}
$AppIcon = New-AppIcon

$icon = New-Object Windows.Forms.NotifyIcon
$icon.Icon = $AppIcon
$icon.Text = 'PCGuard'
$icon.Visible = $true

$menu = New-Object Windows.Forms.ContextMenuStrip
$itemTitle  = $menu.Items.Add('PCGuard 하드웨어 감시')
$itemTitle.Enabled = $false
[void]$menu.Items.Add('-')
$itemStatus = $menu.Items.Add('상태 보기')
$itemSend   = $menu.Items.Add('지금 보고 보내기')
$itemMenu   = $menu.Items.Add('관리 메뉴 열기 (비밀번호 필요)')
$itemLog    = $menu.Items.Add('로그 폴더 열기')
$icon.ContextMenuStrip = $menu

function Show-Status {
    $sum = Get-Summary
    $detail = if ($sum.State) { "`r`n`r`n마지막 확인: $(Format-Time $sum.State.checked_at)`r`n내용: $($sum.State.detail)" } else { '' }
    [Windows.Forms.MessageBox]::Show("PCGuard 하드웨어 감시가 켜져 있어요.`r`n$($sum.Text)$detail", 'PCGuard') | Out-Null
}

$script:lastOk = $null
function Update-Icon {
    $sum = Get-Summary
    $tip = "PCGuard: $($sum.Text)"
    $icon.Text = if ($tip.Length -gt 63) { $tip.Substring(0, 63) } else { $tip }
    $icon.Icon = if ($sum.Ok -eq $false) { [Drawing.SystemIcons]::Warning } else { $AppIcon }
    if ($sum.Ok -eq $false -and $script:lastOk -ne $false) {
        $icon.ShowBalloonTip(5000, 'PCGuard', '서버로 보고를 보내지 못했어요. 네트워크를 확인하세요.', 'Warning')
    }
    $script:lastOk = $sum.Ok
}

# ---- 식별 창 ----

$script:identifyForm = $null
$script:dismissedUntil = $null

function Close-IdentifyWindow {
    if ($script:identifyForm) {
        $script:identifyForm.Close()
        $script:identifyForm = $null
    }
}

function Show-IdentifyWindow($Req) {
    if ($script:identifyForm) { return }
    $f = New-Object Windows.Forms.Form -Property @{
        Text = 'PCGuard 식별'; FormBorderStyle = 'None'; WindowState = 'Maximized'; TopMost = $true
        BackColor = $IdentifyRed; ShowInTaskbar = $true; Icon = $AppIcon
    }
    $layout = New-Object Windows.Forms.TableLayoutPanel -Property @{ Dock = 'Fill'; ColumnCount = 1; RowCount = 5 }
    foreach ($pct in 30, 20, 15, 15, 20) { [void]$layout.RowStyles.Add((New-Object Windows.Forms.RowStyle('Percent', $pct))) }
    function New-Line([string]$Text, [float]$Size, [string]$Style = 'Bold') {
        New-Object Windows.Forms.Label -Property @{
            Text = $Text; Dock = 'Fill'; TextAlign = 'MiddleCenter'; ForeColor = [Drawing.Color]::White
            Font = New-Object Drawing.Font('Malgun Gothic', $Size, [Drawing.FontStyle]$Style)
        }
    }
    $layout.Controls.Add((New-Line '관리자가 이 PC를 찾고 있어요' 40), 0, 0)
    $layout.Controls.Add((New-Line "$($Req.room)  ·  $($Req.hostname)" 48), 0, 1)
    $layout.Controls.Add((New-Line $(if ($Req.message) { $Req.message } else { $env:COMPUTERNAME }) 24 'Regular'), 0, 2)
    $layout.Controls.Add((New-Line "대시보드에서 보낸 요청이에요. $(Format-Time $Req.until)까지 표시돼요." 16 'Regular'), 0, 3)
    $btn = New-Object Windows.Forms.Button -Property @{
        Text = '확인 (창 닫기)'; Anchor = 'None'; Size = New-Object Drawing.Size(260, 60)
        Font = New-Object Drawing.Font('Malgun Gothic', 16, [Drawing.FontStyle]::Bold); BackColor = [Drawing.Color]::White
    }
    $layout.Controls.Add($btn, 0, 4)
    $f.Controls.Add($layout)
    # 이벤트 처리기는 나중에 다른 범위에서 실행되므로 필요한 값은 script 범위에 둡니다.
    $script:identifyUntil = $Req.until
    $btn.Add_Click({ $script:dismissedUntil = $script:identifyUntil; Close-IdentifyWindow })
    $script:identifyForm = $f
    $script:blinkOn = $false
    $script:blinkTimer.Start()

    $f.Show()
    $f.Activate()
    [Console]::Beep(1000, 300)
    Write-TrayLog "identify window shown (until $($Req.until))"
}

# 배경을 빨강과 노랑으로 깜빡여 멀리서도 눈에 띄게 합니다.
$IdentifyRed = [Drawing.Color]::FromArgb(200, 16, 32)
$IdentifyYellow = [Drawing.Color]::FromArgb(250, 190, 0)
$script:blinkTimer = New-Object Windows.Forms.Timer -Property @{ Interval = 700 }
$script:blinkTimer.Add_Tick({
    if (-not $script:identifyForm) { $script:blinkTimer.Stop(); return }
    $script:blinkOn = -not $script:blinkOn
    $script:identifyForm.BackColor = if ($script:blinkOn) { $IdentifyYellow } else { $IdentifyRed }
})

function Get-IdentifyRequest {
    $s = Read-State
    if (-not $s -or -not $s.machine_id -or -not $s.server_url) { return $null }
    $uri = $s.server_url.TrimEnd('/') + '/api/identify?machine_id=' + [uri]::EscapeDataString($s.machine_id)
    $wc = New-Object Net.WebClient
    $wc.Encoding = [Text.Encoding]::UTF8
    try { $wc.DownloadString($uri) | ConvertFrom-Json } finally { $wc.Dispose() }
}

function Update-Identify {
    try {
        $req = Get-IdentifyRequest
    } catch {
        Write-TrayLog "identify poll failed: $($_.Exception.Message)"
        return
    }
    if (-not $req -or -not $req.active) { Close-IdentifyWindow; return }
    if ($script:dismissedUntil -eq $req.until) { return }
    Show-IdentifyWindow $req
}

# ---- 메뉴 동작 ----

$itemStatus.add_Click({ Show-Status })
$icon.add_DoubleClick({ Show-Status })
$itemSend.add_Click({
    Start-Elevated @('-NoProfile', '-Command', "Start-ScheduledTask -TaskName '$TaskName'")
    $icon.ShowBalloonTip(3000, 'PCGuard', '보고를 보냈어요. 잠시 뒤 상태가 바뀝니다.', 'Info')
})
$itemMenu.add_Click({
    Start-Elevated @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$(Join-Path $InstallDir 'menu.ps1')`"")
})
$itemLog.add_Click({ if (Test-Path $DataDir) { Start-Process explorer.exe $DataDir } })

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 30000
$timer.add_Tick({ Update-Icon })
$timer.Start()

$pollTimer = New-Object Windows.Forms.Timer
$pollTimer.Interval = $PollMs
$pollTimer.add_Tick({ Update-Identify })
$pollTimer.Start()

Update-Icon
Update-Identify
Write-TrayLog 'tray started'

try {
    [Windows.Forms.Application]::Run()
} catch {
    Write-TrayLog "tray crashed: $($_.Exception.Message)"
} finally {
    $icon.Visible = $false
    $icon.Dispose()
    $mutex.ReleaseMutex()
}
