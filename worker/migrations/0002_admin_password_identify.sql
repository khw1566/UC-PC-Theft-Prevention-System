-- 관리자 비밀번호 로그인 세션 (토큰은 SHA-256 해시로만 저장)
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- 대시보드에서 'PC 화면에 표시'를 누르면 이 시각까지 해당 PC에 식별 창을 띄웁니다.
ALTER TABLE machines ADD COLUMN identify_until TEXT;
ALTER TABLE machines ADD COLUMN identify_message TEXT;
