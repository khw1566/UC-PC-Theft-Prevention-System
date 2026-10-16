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
export PCGUARD_SCHOOL_NETWORKS=203.0.113.0/24,198.51.100.7   # 학교 공인 IP 대역 (선택, 쉼표로 구분)
uvicorn app.asgi:app --host 127.0.0.1 --port 8000
```

`audreaming.com`의 웹서버(nginx 등)에서 HTTPS로 `/api/`를 `127.0.0.1:8000`에 프록시하면 됩니다. 연락 두절 확인은 cron에 `cd /path/to/server && python -m app.overdue`를 하루 한 번 등록하세요 (`PCGUARD_OVERDUE_DAYS`, 기본 8일).

### 학교 밖 접속 감지

`PCGUARD_SCHOOL_NETWORKS`에 학교 인터넷의 공인 IP(또는 대역)를 적어 두면, PC가 그 밖에서 켜져 보고하는 즉시 **high** 알림을 보냅니다. PC를 통째로 가져간 경우 연락 두절(8일)을 기다리지 않고 바로 알 수 있습니다. 학교 공인 IP는 학교 PC에서 `https://ifconfig.me`에 접속하면 보입니다. 비워 두면 이 검사는 하지 않습니다.

- 밖에 있는 동안 보고가 여러 번 와도 알림은 한 번만 보내고, 학교 안에서 다시 보고하면 감시를 재개합니다.
- 서버가 접속 IP를 정확히 알도록 nginx에서 `proxy_set_header X-Forwarded-For $remote_addr;`로 헤더를 덮어쓰세요. (`$proxy_add_x_forwarded_for`는 클라이언트가 보낸 값을 앞에 남겨 IP를 속일 수 있습니다.)

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

## 학교 PC에 설치

관리자 권한 PowerShell에서:

```powershell
.\client\install.ps1 -ServerUrl https://audreaming.com -ApiKey <PCGUARD_API_KEY>
# 요일/시간 변경: -WeeklyDay Friday -WeeklyTime 16:00
```

전송하지 않고 수집 결과만 보려면 `.\client\collect.ps1 -ConfigPath .\client\config.example.json -DryRun`을 실행하세요. 로그는 `C:\ProgramData\PCGuard\pcguard.log`에 남습니다.

## 판정 기준

- 학교 밖 네트워크에서 켜짐, 메인보드/BIOS 일련번호 변경, CPU·메모리·저장장치·그래픽카드 제거: **high**
- 다른 망(호실)으로 이동, 네트워크카드 제거, 연락 두절: **medium**
- 새 부품 추가: **info** (기록만 하고 알림은 보내지 않음)
- 같은 변경이 계속 보고되면 알림은 처음 한 번만 보냅니다. 정상 교체라면 `accept`로 기준을 갱신하세요.

## 테스트

```bash
cd server && pip install -r requirements-dev.txt && python -m pytest
```
