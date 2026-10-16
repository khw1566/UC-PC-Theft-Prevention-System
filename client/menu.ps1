<#
.SYNOPSIS
    PCGuard 관리 메뉴 (GUI). 디버깅, 테스트 도난 알림, 관리자 메모, 기능 선택적 비활성화.

.DESCRIPTION
    설치 폴더(C:\Program Files\PCGuard)의 config.json은 관리자만 읽을 수 있으므로
    관리자 권한으로 다시 실행합니다. 시작 메뉴의 'PCGuard 관리 메뉴'로 여세요.
    기능 비활성화는 서버가 관리자 키를 확인한 뒤에만 적용됩니다.
#>
[CmdletBinding()]
param([string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'))

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', "`"$PSCommandPath`"", '-ConfigPath', "`"$ConfigPath`""
    )
    return
}

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$TaskName      = 'PCGuard Hardware Check'
$DataDir       = Join-Path $env:ProgramData 'PCGuard'
$LogFile       = Join-Path $DataDir 'pcguard.log'
$QueueDir      = Join-Path $DataDir 'queue'
$CollectScript = Join-Path $PSScriptRoot 'collect.ps1'
$Features      = [ordered]@{ startup_report = '시작 시 보고'; weekly_report = '주간 보고' }

function Show-Message([string]$Text, [string]$Icon = 'Information') {
    [Windows.Forms.MessageBox]::Show($Text, 'PCGuard', 'OK', $Icon) | Out-Null
}

function Write-Log([string]$Message) {
    $line = '{0:yyyy-MM-dd HH:mm:ss} [menu] {1}' -f (Get-Date), $Message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

try {
    $config = Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json
    # collect.ps1과 같은 방법으로 이 PC의 식별자를 구합니다.
    $script:ReportJson = (& $CollectScript -ConfigPath $ConfigPath -DryRun | Out-String)
    $report = $script:ReportJson | ConvertFrom-Json
} catch {
    Show-Message "PCGuard 설정이나 하드웨어 정보를 읽지 못했어요.`r`n$($_.Exception.Message)" 'Error'
    return
}
$MachineId = $report.machine_id

# ---- 서버 통신 ----

function Invoke-Api([string]$Method, [string]$Path, $Body = $null, [string]$AdminKey = $null) {
    $headers = @{ 'X-Api-Key' = $config.api_key }
    if ($AdminKey) { $headers['X-Admin-Key'] = $AdminKey }
    $params = @{
        Method = $Method; Uri = $config.server_url.TrimEnd('/') + $Path
        Headers = $headers; TimeoutSec = 15; UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $params.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 4))
        $params.ContentType = 'application/json; charset=utf-8'
    }
    $res = Invoke-WebRequest @params
    # PowerShell 5.1은 charset 없는 JSON을 UTF-8로 읽지 않으므로 직접 디코딩합니다.
    $text = [Text.Encoding]::UTF8.GetString($res.RawContentStream.ToArray())
    if ($text) { $text | ConvertFrom-Json }
}

function Get-ApiErrorText($ErrorRecord) {
    $code = 0
    try { $code = [int]$ErrorRecord.Exception.Response.StatusCode } catch { }
    switch ($code) {
        0       { "서버에 연결하지 못했어요. ($($ErrorRecord.Exception.Message))" }
        401     { '키가 맞지 않아요.' }
        404     { "서버에 아직 이 PC가 등록되지 않았어요. '상태·디버깅' 탭에서 '지금 보고 보내기'를 먼저 눌러 주세요." }
        429     { '방금 보냈어요. 30초 뒤에 다시 시도해 주세요.' }
        default { "서버 오류 ($code): $($ErrorRecord.Exception.Message)" }
    }
}

function Get-ServerStatus {
    Invoke-Api GET ('/api/client/status?machine_id=' + [uri]::EscapeDataString($MachineId))
}

# ---- 작업 스케줄러 ----

function Get-TriggerState {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { return $null }
    $state = @{ startup_report = $null; weekly_report = $null }
    foreach ($t in $task.Triggers) {
        switch ($t.CimClass.CimClassName) {
            'MSFT_TaskBootTrigger'   { $state.startup_report = [bool]$t.Enabled }
            'MSFT_TaskWeeklyTrigger' { $state.weekly_report = [bool]$t.Enabled }
        }
    }
    $state
}

function Set-TriggerState([bool]$Startup, [bool]$Weekly) {
    $task = Get-ScheduledTask -TaskName $TaskName
    foreach ($t in $task.Triggers) {
        switch ($t.CimClass.CimClassName) {
            'MSFT_TaskBootTrigger'   { $t.Enabled = $Startup }
            'MSFT_TaskWeeklyTrigger' { $t.Enabled = $Weekly }
        }
    }
    $task | Set-ScheduledTask | Out-Null
}

function OnOff($Value) {
    if ($null -eq $Value) { '없음' } elseif ($Value) { '켜짐' } else { '꺼짐' }
}

# ---- 화면 구성 ----

function New-Control([string]$Type, [int[]]$At, [hashtable]$Props = @{}) {
    $c = New-Object "System.Windows.Forms.$Type"
    $c.Bounds = New-Object Drawing.Rectangle($At[0], $At[1], $At[2], $At[3])
    foreach ($k in $Props.Keys) { $c.$k = $Props[$k] }
    $c
}

function Invoke-Safely([scriptblock]$Action) {
    $form.UseWaitCursor = $true
    [Windows.Forms.Application]::DoEvents()
    try { & $Action }
    catch { Show-Message "오류: $($_.Exception.Message)" 'Error' }
    finally { $form.UseWaitCursor = $false }
}

function Show-TextWindow([string]$Title, [string]$Text) {
    $w = New-Object Windows.Forms.Form -Property @{ Text = $Title; Width = 640; Height = 520; StartPosition = 'CenterParent'; Font = $form.Font }
    $box = New-Object Windows.Forms.TextBox -Property @{
        Multiline = $true; ReadOnly = $true; ScrollBars = 'Both'; WordWrap = $false; Dock = 'Fill'
        Font = New-Object Drawing.Font('Consolas', 9); Text = $Text
    }
    $w.Controls.Add($box)
    $w.ShowDialog($form) | Out-Null
}

$form = New-Object Windows.Forms.Form -Property @{
    Text = "PCGuard 관리 메뉴 - $($report.hostname)"; ClientSize = New-Object Drawing.Size(560, 470)
    StartPosition = 'CenterScreen'; FormBorderStyle = 'FixedDialog'; MaximizeBox = $false
    Font = New-Object Drawing.Font('Malgun Gothic', 9); AutoScaleMode = 'Dpi'
}
$tabs = New-Control TabControl @(8, 8, 544, 424)
$statusBar = New-Control Label @(12, 440, 536, 22) @{ ForeColor = [Drawing.Color]::DimGray }
$form.Controls.AddRange(@($tabs, $statusBar))

function Set-Status([string]$Text) { $statusBar.Text = "{0:HH:mm:ss}  {1}" -f (Get-Date), $Text }

function New-Tab([string]$Title) {
    $page = New-Object Windows.Forms.TabPage -Property @{ Text = $Title; Padding = New-Object Windows.Forms.Padding(8) }
    $tabs.TabPages.Add($page)
    $page
}

# 1) 상태·디버깅

$tabInfo = New-Tab '상태·디버깅'
$infoBox = New-Control TextBox @(8, 8, 520, 330) @{
    Multiline = $true; ReadOnly = $true; ScrollBars = 'Vertical'; Font = New-Object Drawing.Font('Consolas', 9)
}
$btnRefresh = New-Control Button @(8, 348, 124, 32) @{ Text = '새로고침' }
$btnSend    = New-Control Button @(140, 348, 124, 32) @{ Text = '지금 보고 보내기' }
$btnView    = New-Control Button @(272, 348, 124, 32) @{ Text = '수집 정보 보기' }
$btnLog     = New-Control Button @(404, 348, 124, 32) @{ Text = '로그 보기' }
$tabInfo.Controls.AddRange(@($infoBox, $btnRefresh, $btnSend, $btnView, $btnLog))

function Update-Info {
    $lines = New-Object Collections.Generic.List[string]
    $lines.Add("PC 이름      : $($report.hostname)")
    $lines.Add("PC 식별자    : $MachineId")
    $lines.Add("모델         : $($report.manufacturer) $($report.product)")
    $lines.Add("OS           : $($report.os)")
    $lines.Add("클라이언트   : $($report.client_version)")
    $lines.Add("서버         : $($config.server_url)")
    $lines.Add('')
    $lines.Add('[이 PC의 예약 작업]')
    $triggers = Get-TriggerState
    if ($null -eq $triggers) {
        $lines.Add("'$TaskName' 작업이 없어요. install.ps1로 다시 설치하세요.")
    } else {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        $lines.Add("시작 시 보고 : $(OnOff $triggers.startup_report)")
        $lines.Add("주간 보고    : $(OnOff $triggers.weekly_report)")
        $lines.Add(('마지막 실행  : {0} (결과 0x{1:X})' -f $info.LastRunTime, $info.LastTaskResult))
        $lines.Add("다음 실행    : $($info.NextRunTime)")
    }
    $queued = @(Get-ChildItem $QueueDir -Filter *.json -ErrorAction SilentlyContinue).Count
    $lines.Add("못 보낸 보고 : ${queued}개")
    $lines.Add('')
    $lines.Add('[서버]')
    try {
        $s = Get-ServerStatus
        if (-not $s.registered) {
            $lines.Add('연결됨. 아직 이 PC가 등록되지 않았어요.')
        } else {
            $lines.Add("연결됨. 호실 $($s.room), 마지막 보고 $(([datetime]$s.last_seen).ToLocalTime())")
            $lines.Add("확인 안 한 알림 : $($s.open_alerts)개")
            if ($s.memo) { $lines.Add("관리자 메모     : $($s.memo)") }
            if ($s.paused_until) { $lines.Add("알림 일시중지   : $(([datetime]$s.paused_until).ToLocalTime())까지") }
            if (@($s.disabled).Count) { $lines.Add("꺼진 기능(서버 기록): $((@($s.disabled) | ForEach-Object { $Features[$_] }) -join ', ')") }
        }
        $script:ServerStatus = $s
    } catch {
        $lines.Add((Get-ApiErrorText $_))
        $script:ServerStatus = $null
    }
    $infoBox.Text = $lines -join "`r`n"
    Set-Status '상태를 새로 읽었어요.'
}

$btnRefresh.Add_Click({ Invoke-Safely { Update-Info } })
$btnSend.Add_Click({
    Invoke-Safely {
        Set-Status '보고를 보내는 중…'
        & $CollectScript -ConfigPath $ConfigPath
        $last = Get-Content $LogFile -Tail 1 -Encoding UTF8 -ErrorAction SilentlyContinue
        Update-Info
        Set-Status "보고 완료: $last"
    }
})
$btnView.Add_Click({ Show-TextWindow '서버로 보내는 하드웨어 정보' $script:ReportJson })
$btnLog.Add_Click({
    if (Test-Path $LogFile) {
        Show-TextWindow 'PCGuard 로그 (최근 200줄)' ((Get-Content $LogFile -Tail 200 -Encoding UTF8) -join "`r`n")
    } else { Show-Message '아직 로그가 없어요.' }
})

# 2) 테스트 도난 알림

$tabTest = New-Tab '테스트 알림'
$tabTest.Controls.AddRange(@(
    (New-Control Label @(8, 12, 520, 60) @{ Text = "서버에 [테스트] 도난 알림을 보내 휴대폰 푸시와 대시보드 표시가 잘 되는지 확인해요.`r`n실제 부품 기준이나 보고 기록은 바뀌지 않고, 대시보드에서 '확인'을 누르면 사라져요." }),
    (New-Control Label @(8, 84, 520, 20) @{ Text = '알림에 함께 보낼 말 (선택)' })
))
$testMsg = New-Control TextBox @(8, 106, 520, 24) @{ MaxLength = 200; Text = '알림 수신 점검' }
$btnTest = New-Control Button @(8, 142, 200, 34) @{ Text = '테스트 도난 알림 보내기' }
$testResult = New-Control Label @(8, 188, 520, 60)
$tabTest.Controls.AddRange(@($testMsg, $btnTest, $testResult))

$btnTest.Add_Click({
    Invoke-Safely {
        try {
            Invoke-Api POST '/api/client/test-alert' @{ machine_id = $MachineId; message = $testMsg.Text } | Out-Null
            $testResult.Text = "보냈어요 ($(Get-Date -Format 'HH:mm:ss')). 휴대폰과 대시보드에 [테스트] 알림이 왔는지 확인하세요."
            Write-Log "test alert sent"
            Set-Status '테스트 알림을 보냈어요.'
        } catch {
            $testResult.Text = Get-ApiErrorText $_
        }
    }
})

# 3) 관리자 메모

$tabMemo = New-Tab '관리자 메모'
$tabMemo.Controls.Add((New-Control Label @(8, 12, 520, 40) @{
    Text = "대시보드에서 이 PC를 알아볼 수 있게 서버에 메모를 남겨요. 예: '3열 5번 자리, 교사용', '모니터 자산번호 A-1234'. 비우고 보내면 메모가 지워져요."
}))
$memoBox = New-Control TextBox @(8, 58, 520, 200) @{ Multiline = $true; MaxLength = 500; ScrollBars = 'Vertical' }
$btnMemoSave = New-Control Button @(8, 268, 140, 34) @{ Text = '서버로 보내기' }
$btnMemoLoad = New-Control Button @(156, 268, 140, 34) @{ Text = '서버에서 불러오기' }
$memoResult = New-Control Label @(8, 312, 520, 40)
$tabMemo.Controls.AddRange(@($memoBox, $btnMemoSave, $btnMemoLoad, $memoResult))

function Read-Memo {
    try {
        $s = Get-ServerStatus
        $memoBox.Text = if ($s.registered) { $s.memo } else { '' }
        $memoResult.Text = if ($s.registered) { '서버의 메모를 불러왔어요.' } else { '이 PC가 아직 서버에 등록되지 않았어요.' }
    } catch { $memoResult.Text = Get-ApiErrorText $_ }
}

$btnMemoLoad.Add_Click({ Invoke-Safely { Read-Memo } })
$btnMemoSave.Add_Click({
    Invoke-Safely {
        try {
            Invoke-Api POST '/api/client/memo' @{ machine_id = $MachineId; memo = $memoBox.Text.Trim() } | Out-Null
            $memoResult.Text = "저장했어요 ($(Get-Date -Format 'HH:mm:ss')). 대시보드의 PC 타일과 상세 화면에 보여요."
            Write-Log 'memo updated'
            Set-Status '메모를 저장했어요.'
        } catch { $memoResult.Text = Get-ApiErrorText $_ }
    }
})

# 4) 선택적 비활성화

$tabOff = New-Tab '비활성화'
$tabOff.Controls.Add((New-Control Label @(8, 12, 520, 40) @{
    Text = '수리·점검처럼 잠시 감시를 멈춰야 할 때 필요한 기능만 꺼요. 관리자 키가 맞아야 적용되고, 서버에도 기록돼요.'
}))
$grp = New-Control GroupBox @(8, 56, 520, 186) @{ Text = '끌 기능' }
$chkStartup = New-Control CheckBox @(16, 24, 480, 24) @{ Text = '시작 시 보고 끄기 (부팅할 때 하드웨어 정보를 보내지 않음)' }
$chkWeekly  = New-Control CheckBox @(16, 52, 480, 24) @{ Text = '주간 보고 끄기 (매주 정해진 시간의 보고를 보내지 않음)' }
$chkPause   = New-Control CheckBox @(16, 84, 300, 24) @{ Text = '서버 도난 알림 일시중지, 기간(시간):' }
$numHours   = New-Control NumericUpDown @(320, 84, 80, 24) @{ Minimum = 1; Maximum = 720; Value = 4 }
$lblPause   = New-Control Label @(36, 112, 470, 64) @{
    ForeColor = [Drawing.Color]::DimGray
    Text = "일시중지 중에는 부품이 바뀌어도 알림과 연락 두절 알림을 보내지 않아요. 기간이 끝난 뒤 첫 보고에서 달라진 점이 있으면 알려요. 정상 교체였다면 대시보드에서 '현재 구성을 정상으로 승인'을 누르세요."
}
$grp.Controls.AddRange(@($chkStartup, $chkWeekly, $chkPause, $numHours, $lblPause))
$tabOff.Controls.Add($grp)
$tabOff.Controls.AddRange(@(
    (New-Control Label @(8, 254, 60, 22) @{ Text = '사유' }),
    (New-Control Label @(8, 286, 60, 22) @{ Text = '관리자 키' })
))
$reasonBox = New-Control TextBox @(72, 250, 456, 24) @{ MaxLength = 200 }
$keyBox    = New-Control TextBox @(72, 282, 456, 24) @{ UseSystemPasswordChar = $true }
$btnApply  = New-Control Button @(8, 318, 140, 34) @{ Text = '적용' }
$offResult = New-Control Label @(156, 318, 372, 60)
$tabOff.Controls.AddRange(@($reasonBox, $keyBox, $btnApply, $offResult))

function Read-DisableState {
    $t = Get-TriggerState
    if ($null -eq $t) {
        $offResult.Text = "'$TaskName' 작업이 없어요. install.ps1로 다시 설치하세요."
        $btnApply.Enabled = $false
        return
    }
    $chkStartup.Checked = ($t.startup_report -eq $false)
    $chkWeekly.Checked = ($t.weekly_report -eq $false)
    $s = $script:ServerStatus
    $chkPause.Checked = [bool]($s -and $s.paused_until)
}

$btnApply.Add_Click({
    Invoke-Safely {
        $key = $keyBox.Text.Trim()
        if (-not $key) { $offResult.Text = '관리자 키를 입력하세요.'; return }
        $disabled = @()
        if ($chkStartup.Checked) { $disabled += 'startup_report' }
        if ($chkWeekly.Checked) { $disabled += 'weekly_report' }
        $hours = if ($chkPause.Checked) { [double]$numHours.Value } else { 0 }

        if ($disabled.Count -eq 2 -and $hours -eq 0) {
            $answer = [Windows.Forms.MessageBox]::Show(
                "보고를 모두 끄고 서버 알림은 그대로 두면, 며칠 뒤 이 PC가 '연락 두절'로 알림이 가요.`r`n그래도 적용할까요?",
                'PCGuard', 'YesNo', 'Warning')
            if ($answer -ne 'Yes') { return }
        }

        # 서버가 관리자 키를 확인해야만 이 PC의 설정도 바꿉니다.
        try {
            Invoke-Api POST "/api/machines/$([uri]::EscapeDataString($MachineId))/disable" `
                @{ hours = $hours; reason = $reasonBox.Text.Trim(); disabled = $disabled } $key | Out-Null
        } catch {
            $offResult.Text = "적용하지 않았어요. $(Get-ApiErrorText $_)"
            return
        }
        Set-TriggerState -Startup (-not $chkStartup.Checked) -Weekly (-not $chkWeekly.Checked)
        $keyBox.Clear()

        $off = @($disabled | ForEach-Object { $Features[$_] })
        if ($hours -gt 0) { $off += "서버 알림 ${hours}시간" }
        $summary = if ($off.Count) { "꺼짐: $($off -join ', ')" } else { '모든 기능이 켜졌어요.' }
        $offResult.Text = "적용했어요. $summary"
        Write-Log "disable applied: features=[$($disabled -join ',')] pause_hours=$hours reason=$($reasonBox.Text.Trim())"
        Update-Info
        Set-Status $summary
    }
})

$form.Add_Shown({
    Invoke-Safely {
        Update-Info
        Read-DisableState
        if ($script:ServerStatus) { $memoBox.Text = $script:ServerStatus.memo }
    }
})
[Windows.Forms.Application]::Run($form)
