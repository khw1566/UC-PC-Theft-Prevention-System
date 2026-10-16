# PCGuard: 학교 PC 하드웨어 도난 감시

학교 PC가 켜질 때와 매주 정해진 시간에 하드웨어 구성(CPU, 메모리, 저장장치, 그래픽카드, 네트워크카드, 메인보드/BIOS 일련번호)을 수집해 `audreaming.com` 서버로 보냅니다. 서버는 처음 받은 구성을 기준으로 저장해 두고, 부품이 사라지거나 바뀌면 알림을 보냅니다. 정해진 기간 동안 보고가 없는 PC도 알려 줍니다.

```
[학교 PC] collect.ps1 ──HTTPS POST /api/report──▶ [audreaming.com] FastAPI + SQLite ──▶ 웹 푸시 (휴대폰/PC 브라우저)
   (부팅 시 + 매주, SYSTEM 권한)                       기준 구성과 비교, 변경 시 알림   └▶ Discord/Slack 웹훅 (선택)
                                                      └ 웹 대시보드: 호실(망)별 PC 상태
```

## 웹 대시보드

`https://audreaming.com/`에 접속해 관리자 키로 로그인하면 PC가 **호실(망)별로** 묶여 보입니다.

- 각 PC는 기본 게이트웨이가 있는 네트워크의 서브넷(예: `10.1.3.0/24`)으로 호실이 정해집니다. 호실 카드의 `✎ 이름`을 눌러 `301호 컴퓨터실`처럼 이름을 붙이세요.
- PC 타일 색: 초록 정상, 주황 주의(호실 이동, 네트워크카드 제거 등), 빨강 이상(부품 제거, 메인보드 교체), 회색 연락 두절.
- PC를 누르면 부품 목록, 기준과 다른 점, 알림 기록이 나오고, 정상적인 교체였다면 `현재 구성을 정상으로 승인`으로 기준을 갱신합니다.
- 화면은 30초마다, 그리고 앱으로 돌아올 때마다 새로 고칩니다.

### 휴대폰 알림 받기

1. 휴대폰 브라우저로 대시보드에 로그인합니다.
2. **안드로이드(Chrome/삼성 인터넷)**: 상단 `🔔 알림 켜기`를 누르고 허용하면 테스트 알림이 옵니다.
3. **아이폰(iOS 16.4 이상)**: Safari 공유 버튼 → `홈 화면에 추가` → 홈 화면의 PCGuard 앱을 열고 `🔔 알림 켜기`를 누릅니다. (아이폰은 홈 화면에 추가한 앱에서만 웹 푸시가 됩니다.)
4. 알림을 누르면 해당 PC 상세 화면이 바로 열립니다.

웹 푸시는 HTTPS에서만 동작합니다. 서명 키(VAPID)는 처음 실행 때 자동으로 만들어 DB에 저장되므로 DB 파일을 지우면 기기마다 알림을 다시 켜야 합니다.

## 구성

| 경로 | 내용 |
|---|---|
| `client/collect.ps1` | 하드웨어 수집 및 전송. 실패하면 `C:\ProgramData\PCGuard\queue`에 쌓았다가 다음 실행 때 재전송 |
| `client/install.ps1` | `C:\Program Files\PCGuard`에 설치하고 작업 스케줄러에 등록 (부팅 2분 후 + 매주) |
| `client/menu.ps1` | PC에서 여는 관리 메뉴 GUI (상태·디버깅, 테스트 도난 알림, 관리자 메모, 기능 비활성화) |
| `client/uninstall.ps1` | 작업과 파일 제거 |
| `server/app/` | 보고 수신, 기준 비교, 알림, 대시보드 API |
| `server/app/static/` | 웹 대시보드 (설치형 웹앱, 서비스 워커로 푸시 수신) |
| `server/app/overdue.py` | 오래 보고가 없는 PC 알림 (cron으로 매일 실행) |

## 서버 실행

```bash
cd server
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export PCGUARD_API_KEY=$(openssl rand -hex 24)     # 클라이언트용
export PCGUARD_ADMIN_KEY=$(openssl rand -hex 24)   # 대시보드 로그인용
export PCGUARD_WEBHOOK_URL=https://discord.com/api/webhooks/...   # 선택
export PCGUARD_DB=/var/lib/pcguard/pcguard.db
uvicorn app.asgi:app --host 127.0.0.1 --port 8000
```

`audreaming.com`의 웹서버(nginx 등)에서 HTTPS로 `/api/`를 `127.0.0.1:8000`에 프록시하면 됩니다. 연락 두절 확인은 cron에 `cd /path/to/server && python -m app.overdue`를 하루 한 번 등록하세요 (`PCGUARD_OVERDUE_DAYS`, 기본 8일).

### API

| 메서드 | 경로 | 인증 헤더 | 설명 |
|---|---|---|---|
| POST | `/api/report` | `X-Api-Key` | 클라이언트 보고. 첫 보고는 기준으로 등록 |
| GET | `/api/dashboard` | `X-Admin-Key` | 호실별 PC 상태와 확인 안 한 알림 |
| GET | `/api/machines` | `X-Admin-Key` | 등록된 PC 목록 |
| GET | `/api/machines/{id}` | `X-Admin-Key` | PC 상세 (부품, 기준과 다른 점, 알림 기록) |
| POST | `/api/rooms` | `X-Admin-Key` | `{"subnet", "name"}`으로 호실 이름 지정 |
| GET | `/api/push/key` | 없음 | 웹 푸시 공개키 |
| POST | `/api/push/subscribe` | `X-Admin-Key` | 이 브라우저를 푸시 수신자로 등록 |
| POST | `/api/push/test` | `X-Admin-Key` | 테스트 알림 |
| GET | `/api/alerts` | `X-Admin-Key` | 확인 안 한 알림 (`?include_acknowledged=true`로 전체) |
| POST | `/api/alerts/{id}/ack` | `X-Admin-Key` | 알림 확인 처리 |
| POST | `/api/machines/{id}/accept` | `X-Admin-Key` | 현재 구성을 새 기준으로 승인하고 그 PC의 알림을 확인 처리 |
| GET | `/api/client/status?machine_id=` | `X-Api-Key` | 관리 메뉴용: 등록 여부, 호실, 메모, 일시중지, 꺼진 기능 |
| POST | `/api/client/memo` | `X-Api-Key` | `{"machine_id", "memo"}` 관리자 메모 저장 (최대 500자, 빈 값이면 삭제) |
| POST | `/api/client/test-alert` | `X-Api-Key` | `{"machine_id", "message"}` 심각도 `test`인 알림 기록 + 푸시. 같은 PC는 30초에 한 번 |
| POST | `/api/machines/{id}/disable` | `X-Admin-Key` | `{"hours", "reason", "disabled"}` 서버 알림을 `hours`시간 일시중지(0이면 해제)하고 PC에서 끈 기능(`startup_report`, `weekly_report`)을 기록 |

## 학교 PC에 설치

관리자 권한 PowerShell에서:

```powershell
.\client\install.ps1 -ServerUrl https://audreaming.com -ApiKey <PCGUARD_API_KEY>
# 요일/시간 변경: -WeeklyDay Friday -WeeklyTime 16:00
```

### PC의 관리 메뉴 (GUI)

설치하면 시작 메뉴에 **PCGuard 관리 메뉴**가 생깁니다. 관리자 권한으로만 열리므로 학생 계정은 UAC에서 막힙니다.

- **상태·디버깅**: PC 식별자, 예약 작업 상태(마지막/다음 실행), 못 보낸 보고 수, 서버 연결과 등록 상태를 보여 줍니다. `지금 보고 보내기`, `수집 정보 보기`(서버로 보내는 JSON), `로그 보기`.
- **테스트 알림**: `[테스트]` 도난 알림을 보내 휴대폰 푸시와 대시보드 표시를 확인합니다. 기준 구성은 바뀌지 않고, 대시보드에서 `확인`을 누르면 사라집니다.
- **관리자 메모**: `3열 5번 자리, 교사용`처럼 PC를 알아볼 메모를 서버에 저장합니다. 대시보드의 PC 타일과 상세 화면에 보입니다.
- **비활성화**: 시작 시 보고, 주간 보고, 서버 도난 알림(1~720시간 일시중지)을 골라서 끕니다. **관리자 키**(`PCGUARD_ADMIN_KEY`)를 서버가 확인해야만 적용됩니다. 일시중지 중엔 부품 변경 알림과 연락 두절 알림을 보내지 않고, 기간이 끝난 뒤 첫 보고에서 달라진 점이 있으면 알립니다. 대시보드에서는 보라색 `일시중지`로 표시되고 상세 화면에서 바로 해제할 수 있습니다.

전송하지 않고 수집 결과만 보려면 `.\client\collect.ps1 -ConfigPath .\client\config.example.json -DryRun`을 실행하세요. 로그는 `C:\ProgramData\PCGuard\pcguard.log`에 남습니다.

## 판정 기준

- 메인보드/BIOS 일련번호 변경, CPU·메모리·저장장치·그래픽카드 제거: **high**
- 다른 망(호실)으로 이동, 네트워크카드 제거, 연락 두절: **medium**
- 새 부품 추가: **info** (기록만 하고 알림은 보내지 않음)
- 관리 메뉴의 테스트 알림: **test** (확인 전까지 PC가 주의로 표시)
- 같은 변경이 계속 보고되면 알림은 처음 한 번만 보냅니다. 정상 교체라면 `accept`로 기준을 갱신하세요.

## 테스트

```bash
cd server && pip install -r requirements-dev.txt && python -m pytest
```
