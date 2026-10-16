<#
.SYNOPSIS
    PCGuard 작업표시줄 아이콘. 로그인한 사용자 세션에서 알림 영역에 상주하며 마지막 보고 상태를 보여 줍니다.

.DESCRIPTION
    보고 자체는 작업 스케줄러(SYSTEM)가 하고, 이 아이콘은 C:\ProgramData\PCGuard\state.json만 읽습니다.
    키가 든 config.json은 읽지 않으므로 학생 계정으로 실행돼도 안전합니다.
    관리 메뉴와 '지금 보고 보내기'는 관리자 권한(UAC)을 요청합니다.
#>
[CmdletBinding()]
param()

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

# 사용자마다 아이콘은 하나만 띄웁니다.
$created = $false
$mutex = New-Object Threading.Mutex($true, 'Local\PCGuardTray', [ref]$created)
if (-not $created) { return }

$InstallDir = $PSScriptRoot
$DataDir    = Join-Path $env:ProgramData 'PCGuard'
$StateFile  = Join-Path $DataDir 'state.json'
$TaskName   = 'PCGuard Hardware Check'

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

$icon = New-Object Windows.Forms.NotifyIcon
$icon.Icon = [Drawing.SystemIcons]::Shield
$icon.Visible = $true

$menu = New-Object Windows.Forms.ContextMenuStrip
$itemStatus = $menu.Items.Add('상태 보기')
$itemSend   = $menu.Items.Add('지금 보고 보내기')
$itemMenu   = $menu.Items.Add('관리 메뉴 열기')
$itemLog    = $menu.Items.Add('로그 폴더 열기')
[void]$menu.Items.Add('-')
$itemExit   = $menu.Items.Add('아이콘 숨기기')
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
    $icon.Icon = if ($sum.Ok -eq $false) { [Drawing.SystemIcons]::Warning } else { [Drawing.SystemIcons]::Shield }
    if ($sum.Ok -eq $false -and $script:lastOk -ne $false) {
        $icon.ShowBalloonTip(5000, 'PCGuard', '서버로 보고를 보내지 못했어요. 네트워크를 확인하세요.', 'Warning')
    }
    $script:lastOk = $sum.Ok
}

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
$itemExit.add_Click({
    $icon.Visible = $false
    [Windows.Forms.Application]::Exit()
})

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 30000
$timer.add_Tick({ Update-Icon })
$timer.Start()
Update-Icon

[Windows.Forms.Application]::Run()
$icon.Dispose()
$mutex.ReleaseMutex()
