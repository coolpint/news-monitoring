# News Monitoring (Cloudflare Worker)

뉴스 키워드 모니터링 알림을 `5분 주기`로 수집하고, 키워드 소유자와 무관하게 `전체 활성 Teams/Slack/Telegram 채널`로 공통 발송하는 웹앱입니다.

- 기본 모드: `multi_user_teams` (회사 사용자별 키워드 + Teams 중심)
- 대체 모드: `single_user_slack` (1인 운영 + Slack 중심)
- 실행 인프라: Cloudflare Workers + D1 + Cron Trigger

## 주요 기능

- 사용자 로그인/세션 관리
- 사용자별 키워드 관리(정확일치 OR + 꼭 포함 + 제외)
- 주제어 그룹 기능(`주제어>검색어` 라벨로 알림 식별)
- 매체 티어 기반 필터(티어1~티어4)
- 매체 URL 등록 + RSS/네이버 가능 여부 자동 검사
- 전역 알림 채널(Teams/Slack/Telegram) 관리
- 5분 크론 수집(`*/5 * * * *`)
- 중복 기사 방지(해시 키 기반)
- 24시간 신선도 필터(기본 24h, `published_at` 없으면 유연 허용)
- Google RSS 팬아웃 수집(검색어 단일 + OR 보강)
- Naver API fallback(일 1000회/런당 4회 기본 캡)
- 실행 락 + stale run 자동 정리(중첩 실행 방지)
- 수동 실행 버튼 + 실행 이력 확인
- 운영 제한값(`MAX_USERS`, `MAX_KEYWORDS_PER_USER`)으로 무료 티어 보호

## 아키텍처

1. `scheduled` 이벤트(5분) 또는 수동 실행 호출
2. `poll` 락 획득 + stale `running` 정리
3. 활성 키워드별 Google RSS 팬아웃 수집 + 커스텀 RSS 수집
4. Google fresh hit 부족 시 Naver fallback 보강(Stage A), unavailable 매체 `site:` 보강(Stage B)
5. 24시간 필터 적용 후 기사/알림 큐 적재
6. 채널별로 묶어 Teams/Slack/Telegram 발송
7. 결과를 `poll_runs`에 저장

## 키워드 검색 규칙

- `검색어`: 여러 개 입력 가능, 각 검색어는 정확 일치(문구) 기준이며 OR 조건으로 동작
- `꼭 포함`: 복수 입력 가능, 기사 제목/요약에 모든 단어가 포함되어야 통과
- `제외`: 복수 입력 가능, 하나라도 포함되면 알림 제외
- `주제어 그룹`: 예) `지바이크>경쟁사`, `지바이크>PM`, `지바이크>지쿠`처럼 묶어서 알림에서 바로 맥락 식별
- `매체 티어`: 키워드별로 티어1~4를 선택해 해당 티어 매체 기사만 알림
- `키워드 수정`: 생성 후 주제어/검색어/포함/제외/티어를 UI에서 수정 가능

## 매체 티어 동작

- RSS의 매체명/매체 URL을 파싱해 티어를 판정합니다.
- 티어 목록은 앱의 `매체 티어` 섹션에서 확인할 수 있습니다.
- 키워드에서 티어를 전부 선택하면 전체 매체 대상이고, 일부만 선택하면 해당 티어로 필터링됩니다.
- 기본 티어 목록(약 33개)은 `초기 분류용 샘플`이며, 수집 전체 매체 수의 상한이 아닙니다.
- `매체 URL`을 추가하면 자체 RSS/네이버 뉴스검색 가능 여부를 검사해서 저장합니다.
- 자체 RSS가 확인된 매체는 크론 수집 시 추가 RSS 소스로 함께 수집됩니다.

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
npx wrangler secret put NAVER_CLIENT_ID
npx wrangler secret put NAVER_CLIENT_SECRET
```

`NAVER_CLIENT_ID/SECRET`은 Naver Open API fallback을 사용할 때만 필요합니다. 미설정 시 Google+RSS만 동작합니다.

### 5) 배포

```bash
npx wrangler deploy
```

배포 후 Worker URL 접속:

- 최초 1회 관리자 계정 생성
- 관리자 로그인 후 사용자/키워드/채널 설정

## 로컬 꺼도 계속 동작하게 만들기 (권장 순서)

한 번만 아래를 완료하면, 이후에는 로컬 PC가 꺼져 있어도 Cloudflare에서 24시간 동작합니다.

1. `wrangler.toml`의 `database_id`를 실제 D1 ID로 수정
2. `SESSION_SECRET` 시크릿 등록
3. `npx wrangler d1 execute news_monitoring --remote --file=./sql/schema.sql` 실행
4. `npx wrangler deploy` 실행
5. Cloudflare Dashboard에서 Cron Trigger가 `*/5 * * * *`로 보이는지 확인
6. Worker URL 접속 후 관리자 계정 생성
7. Teams webhook 채널 + 키워드 등록
8. UI의 `지금 수집 실행` 버튼으로 테스트 알림 확인

이 상태가 되면 스케줄 실행, 데이터 저장(D1), 알림 발송이 모두 Cloudflare에서 수행됩니다.

## 모드 전환

`wrangler.toml`의 `APP_MODE`를 변경합니다.

```toml
[vars]
APP_MODE = "multi_user_teams" # 또는 single_user_slack
MAX_USERS = "30"
MAX_KEYWORDS_PER_USER = "40"
MAX_CUSTOM_RSS_SOURCES_PER_RUN = "20"
NEWS_MAX_AGE_HOURS = "24"
GOOGLE_FETCH_TIMEOUT_MS = "8000"
GOOGLE_FETCH_CONCURRENCY = "4"
NAVER_DAILY_LIMIT = "1000"
NAVER_PER_RUN_LIMIT = "4"
RUN_LOCK_TTL_SECONDS = "270"
RUN_STALE_TIMEOUT_MINUTES = "15"
```

## 운영 점검 API

- `GET /api/keywords/:id/diagnose`
  - freshness 지표(`fresh_kept`, `stale_dropped`, `missing_published_kept`)
  - source 지표(`google_count`, `custom_rss_count`, `naver_count`)
  - Naver 예산 지표(`naver_used_today`, `naver_remaining_today`)
- `GET /api/source-health` (admin)
  - Naver 일일 예산/잔량, poll lock 상태, stale running count 요약

### multi_user_teams

- 관리자 계정으로 사내 사용자 추가
- 전역 Teams/Slack/Telegram 채널 등록(키워드 소유자와 무관하게 공통 발송)
- 사용자별 키워드 운영

### single_user_slack

- 추가 사용자 생성 차단
- 채널 타입을 Slack만 허용
- 1인 비용절감 운영에 적합

## Teams 웹훅 팁

- Teams는 기존 Connector 대신 Workflows 웹훅 방식이 권장됩니다.
- 환경에 따라 payload 형식이 달라질 수 있어, 코드에서 기본 text payload 실패 시 Adaptive Card payload를 재시도하도록 구현되어 있습니다.

## Telegram 설정 팁

- BotFather에서 봇 생성 후 `bot token` 발급
- 알림 받을 채팅(개인/그룹)의 `chat_id` 확인
- 채널 추가 시 타입을 `telegram`으로 선택
- Webhook URL 입력 형식:
  - `tg://<bot_token>/<chat_id>` (권장)
  - 또는 `https://api.telegram.org/bot<bot_token>/sendMessage?chat_id=<chat_id>`

## GitHub에 커밋만 하면 되나?

커밋/푸시만으로는 상시 실행되지 않습니다.

상시 실행 조건:

1. GitHub에 코드 저장
2. Cloudflare Worker 배포
3. D1 스키마 적용
4. Cron Trigger 활성화(현재 `*/5` 설정)

즉, 원격에서 계속 돌리려면 Cloudflare 배포까지 완료되어야 합니다.

## GitHub 자동 배포 (선택)

`.github/workflows/deploy.yml`이 포함되어 있어, `main` 푸시 때 자동 배포할 수 있습니다.

GitHub 저장소 `Settings > Secrets and variables > Actions`에 아래 두 개를 추가하세요.

- `CLOUDFLARE_API_TOKEN`: Workers/D1 배포 권한이 있는 토큰
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare Account ID
- `D1_DATABASE_ID`: D1 생성 시 출력되는 database id (UUID)

`D1_DATABASE_ID` 확인 방법:
- `npx wrangler d1 create news_monitoring` 실행 시 출력되는 `database_id` 사용
- 또는 Cloudflare Dashboard > D1 > 해당 DB > Settings에서 ID 확인

초기 1회는 로컬에서 D1 생성/스키마 적용이 필요하고, 그 이후 코드 변경은 GitHub 푸시로 자동 배포할 수 있습니다.

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
- GitHub Actions: `.github/workflows/deploy.yml`
