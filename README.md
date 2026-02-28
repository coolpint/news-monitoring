# News Monitoring (Cloudflare Worker)

뉴스 키워드 모니터링 알림을 `5분 주기`로 수집하고, 사용자별로 서로 다른 키워드를 설정해 `Teams/Slack` 웹훅으로 보내는 웹앱입니다.

- 기본 모드: `multi_user_teams` (회사 사용자별 키워드 + Teams 중심)
- 대체 모드: `single_user_slack` (1인 운영 + Slack 중심)
- 실행 인프라: Cloudflare Workers + D1 + Cron Trigger

## 주요 기능

- 사용자 로그인/세션 관리
- 사용자별 키워드/제외어 관리
- 사용자별 알림 채널(Teams/Slack webhook) 관리
- 5분 크론 수집(`*/5 * * * *`)
- 중복 기사 방지(해시 키 기반)
- 수동 실행 버튼 + 실행 이력 확인
- 운영 제한값(`MAX_USERS`, `MAX_KEYWORDS_PER_USER`)으로 무료 티어 보호

## 아키텍처

1. `scheduled` 이벤트(5분) 또는 수동 실행 호출
2. 활성 키워드 쿼리별 RSS 수집(`google_rss`)
3. 기사 중복 제거 후 `notifications` 큐 적재
4. 채널별로 묶어 Teams/Slack 웹훅 발송
5. 결과를 `poll_runs`에 저장

## 빠른 시작

### 1) 준비

```bash
npm install
npx wrangler login
```

### 2) D1 생성

```bash
npx wrangler d1 create news_monitoring
```

출력된 `database_id`를 `wrangler.toml`의 `[[d1_databases]]`에 반영합니다.

### 3) 스키마 반영

```bash
npx wrangler d1 execute news_monitoring --remote --file=./sql/schema.sql
```

### 4) 시크릿 등록

```bash
npx wrangler secret put SESSION_SECRET
```

### 5) 배포

```bash
npx wrangler deploy
```

배포 후 Worker URL 접속:

- 최초 1회 관리자 계정 생성
- 관리자 로그인 후 사용자/키워드/채널 설정

## 모드 전환

`wrangler.toml`의 `APP_MODE`를 변경합니다.

```toml
[vars]
APP_MODE = "multi_user_teams" # 또는 single_user_slack
MAX_USERS = "30"
MAX_KEYWORDS_PER_USER = "40"
```

### multi_user_teams

- 관리자 계정으로 사내 사용자 추가
- 사용자별 Teams 웹훅 등록
- 사용자별 키워드 운영

### single_user_slack

- 추가 사용자 생성 차단
- 채널 타입을 Slack만 허용
- 1인 비용절감 운영에 적합

## Teams 웹훅 팁

- Teams는 기존 Connector 대신 Workflows 웹훅 방식이 권장됩니다.
- 환경에 따라 payload 형식이 달라질 수 있어, 코드에서 기본 text payload 실패 시 Adaptive Card payload를 재시도하도록 구현되어 있습니다.

## GitHub에 커밋만 하면 되나?

커밋/푸시만으로는 상시 실행되지 않습니다.

상시 실행 조건:

1. GitHub에 코드 저장
2. Cloudflare Worker 배포
3. D1 스키마 적용
4. Cron Trigger 활성화(현재 `*/5` 설정)

즉, 원격에서 계속 돌리려면 Cloudflare 배포까지 완료되어야 합니다.

## 무료 티어 관점 운영 가이드

- 5분 주기면 하루 288회 실행
- 쿼리 수가 늘수록 외부 RSS 요청/DB 쓰기/웹훅 전송이 함께 증가
- 무료 유지가 어려워지면:
  1. `single_user_slack` 전환
  2. 키워드 수 축소
  3. 제외어 강화로 불필요 알림 축소

## 개발 참고

- 엔트리: `src/worker.js`
- UI: `src/ui.js`
- DB 스키마: `sql/schema.sql`
