# PCGuard: 학교 PC 하드웨어 도난 감시

학교 PC가 켜질 때와 매주 정해진 시간에 하드웨어 구성(CPU, 메모리, 저장장치, 그래픽카드, 네트워크카드, 메인보드/BIOS 일련번호)을 수집해 `audreaming.com` 서버로 보냅니다. 서버는 처음 받은 구성을 기준으로 저장해 두고, 부품이 사라지거나 바뀌면 알림을 보냅니다. 정해진 기간 동안 보고가 없는 PC도 알려 줍니다.

```
[학교 PC] collect.ps1 ──HTTPS POST /api/report──▶ [audreaming.com] FastAPI + SQLite ──▶ Discord/Slack 웹훅
   (부팅 시 + 매주, SYSTEM 권한)                       기준 구성과 비교, 변경 시 알림
```

## 구성

| 경로 | 내용 |
|---|---|
| `client/collect.ps1` | 하드웨어 수집 및 전송. 실패하면 `C:\ProgramData\PCGuard\queue`에 쌓았다가 다음 실행 때 재전송 |
| `client/install.ps1` | `C:\Program Files\PCGuard`에 설치하고 작업 스케줄러에 등록 (부팅 2분 후 + 매주) |
| `client/uninstall.ps1` | 작업과 파일 제거 |
| `server/app/` | 보고 수신, 기준 비교, 알림 API |
| `server/app/overdue.py` | 오래 보고가 없는 PC 알림 (cron으로 매일 실행) |

## 서버 실행

```bash
cd server
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export PCGUARD_API_KEY=$(openssl rand -hex 24)     # 클라이언트용
export PCGUARD_ADMIN_KEY=$(openssl rand -hex 24)   # 관리자용
export PCGUARD_WEBHOOK_URL=https://discord.com/api/webhooks/...   # 선택
export PCGUARD_DB=/var/lib/pcguard/pcguard.db
uvicorn app.asgi:app --host 127.0.0.1 --port 8000
```

`audreaming.com`의 웹서버(nginx 등)에서 HTTPS로 `/api/`를 `127.0.0.1:8000`에 프록시하면 됩니다. 연락 두절 확인은 cron에 `cd /path/to/server && python -m app.overdue`를 하루 한 번 등록하세요 (`PCGUARD_OVERDUE_DAYS`, 기본 8일).

### API

| 메서드 | 경로 | 인증 헤더 | 설명 |
|---|---|---|---|
| POST | `/api/report` | `X-Api-Key` | 클라이언트 보고. 첫 보고는 기준으로 등록 |
| GET | `/api/machines` | `X-Admin-Key` | 등록된 PC 목록 |
| GET | `/api/alerts` | `X-Admin-Key` | 확인 안 한 알림 (`?include_acknowledged=true`로 전체) |
| POST | `/api/alerts/{id}/ack` | `X-Admin-Key` | 알림 확인 처리 |
| POST | `/api/machines/{id}/accept` | `X-Admin-Key` | 정상적인 부품 교체 후 현재 구성을 새 기준으로 승인 |

## 학교 PC에 설치

관리자 권한 PowerShell에서:

```powershell
.\client\install.ps1 -ServerUrl https://audreaming.com -ApiKey <PCGUARD_API_KEY>
# 요일/시간 변경: -WeeklyDay Friday -WeeklyTime 16:00
```

전송하지 않고 수집 결과만 보려면 `.\client\collect.ps1 -ConfigPath .\client\config.example.json -DryRun`을 실행하세요. 로그는 `C:\ProgramData\PCGuard\pcguard.log`에 남습니다.

## 판정 기준

- 메인보드/BIOS 일련번호 변경, CPU·메모리·저장장치·그래픽카드 제거: **high**
- 네트워크카드 제거, 연락 두절: **medium**
- 새 부품 추가: **info** (기록만 하고 알림은 보내지 않음)
- 같은 변경이 계속 보고되면 알림은 처음 한 번만 보냅니다. 정상 교체라면 `accept`로 기준을 갱신하세요.

## 테스트

```bash
cd server && pip install -r requirements-dev.txt && python -m pytest
```
