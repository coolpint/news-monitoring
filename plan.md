# 뉴스 누락/과거기사 문제 해결 로직 기록

## 1. 문제 정의

### 1) 누락(리콜 부족)
- Google RSS를 단일 OR 쿼리 + 상위 20건으로만 처리하면 고빈도 주제에서 결과가 잘립니다.
- 키워드 변형이 많은 주제(`지바이크` 등)에서 일부 최신 기사 누락 가능성이 큽니다.

### 2) 과거기사 유입
- 수집 파이프라인에 `published_at` 기준 24시간 필터가 없어 과거 기사가 신규 알림으로 들어올 수 있었습니다.

### 3) 중첩 실행
- `poll_runs.status='running'`이 누적되는 상황이 발생했고, 크론 중첩/타임아웃이 의심되었습니다.

## 2. 확정 정책 (오늘 결정)

1. 24시간 정책: 유연 차단  
`published_at`이 있으면 24h 기준으로 차단, 없으면 허용.
2. Naver 예산 정책: 2단계 배분 + 1일 최대 1000회.
3. 실행 중첩 정책: 락 + stale 정리.
4. 키워드 세트 정책: 현재 DB 키워드 유지(Neusral 자동 동기화 제외).

## 3. 수집 파이프라인 로직 (의사코드)

```text
runPoll(trigger):
  ensure runtime tables(job_locks, api_usage_daily, app_state)
  stale_cleaned = cleanup stale running polls(> RUN_STALE_TIMEOUT_MINUTES)

  if acquire lock("poll", RUN_LOCK_TTL_SECONDS) == false:
    record poll_runs as skipped_locked
    return

  insert poll_runs running
  cutoff = now_utc - NEWS_MAX_AGE_HOURS

  keywords = load active keywords + active channels
  groups = group by (source, compiled_query) with merged search_terms

  custom_rss_raw = fetch managed RSS
  custom_rss_fresh = freshness_filter(custom_rss_raw, cutoff)

  naver_budget = init day budget (daily limit + per-run limit)

  for each group:
    google_raw = fetch google fanout queries(term fanout + OR query)
    google_fresh = freshness_filter(google_raw, cutoff)
    if google_fresh.count < 2:
      stageA candidate

  run Stage A naver fallback with remaining run budget:
    per candidate group: reserve 1 call, fetch query, freshness filter

  run Stage B naver fallback with remaining run budget:
    unavailable media domains round-robin:
      reserve 1 call -> fetch site:domain -> collect

  for each group:
    merged = dedupe(google_fresh + custom_rss_fresh + stageA + stageB)
    apply keyword filters (tier/search/must/exclude)
    upsert articles
    enqueue notifications pending

  send pending notifications
    with SQL guard:
      COALESCE(published_at, first_seen_at) >= cutoff

  mark poll_runs success/failure
  release lock in finally
```

## 4. Naver 예산 알고리즘 (1000/day, 2단계 배분)

### 테이블
- `api_usage_daily(day, source, used)`  
  - PK: `(day, source)`
- source 값: `naver_news`

### 런타임 예산 계산
- `daily_remaining = NAVER_DAILY_LIMIT - used_today`
- `run_remaining = min(NAVER_PER_RUN_LIMIT, daily_remaining)`

### 호출 순서
1. Stage A: Google fresh hit가 부족한 키워드(`fresh < 2`) 우선 보강
2. Stage B: `probe_status='unavailable'` 매체를 `site:domain` 쿼리로 보강
   - `app_state.naver_unavailable_cursor`를 이용한 라운드로빈

### 호출 단위
- 실제 Naver API 요청 1회마다 usage +1
- 일일/런 예산이 0이면 즉시 skip

## 5. 락/스테일 정리 상태머신

### 락
- `job_locks(name='poll')` 사용
- 시작 시 만료 락 삭제 후 `INSERT ... ON CONFLICT DO NOTHING`으로 획득
- 획득 실패 시 run 상태를 `skipped_locked`로 기록하고 종료
- `finally`에서 `owner_run_id` 조건으로 안전 해제

### stale run 정리
- 시작 시 `status='running'`이고 시작 후 `RUN_STALE_TIMEOUT_MINUTES` 초과인 run을
  `failed(stale_timeout)`로 정리

## 6. 실패 모드 / 복구 전략

1. Google 일부 쿼리 timeout
- 팬아웃 개별 실패만 무시, 나머지 쿼리 결과로 진행
- `GOOGLE_FETCH_TIMEOUT_MS`, `GOOGLE_FETCH_CONCURRENCY` 조정 가능

2. Naver credential 미설정
- Naver fallback 자동 비활성화
- Google + RSS만으로 동작

3. Naver quota 소진
- 당일 사용량이 한도 도달 시 즉시 fallback 중지
- 다음 날(Asia/Seoul 기준 day key) 자동 재개

4. 크론 중첩
- lock으로 중복 실행 차단
- 잔존 running/stale는 다음 run 시작 시 자동 정리

## 7. 운영 체크리스트 (배포 후 검증 쿼리 포함)

### 1) 배포/스키마
```bash
npx wrangler d1 execute news_monitoring --remote --file=./sql/schema.sql
npx wrangler deploy
```

### 2) 환경/시크릿
- vars:
  - `NEWS_MAX_AGE_HOURS=24`
  - `GOOGLE_FETCH_TIMEOUT_MS=8000`
  - `GOOGLE_FETCH_CONCURRENCY=4`
  - `NAVER_DAILY_LIMIT=1000`
  - `NAVER_PER_RUN_LIMIT=4`
  - `RUN_LOCK_TTL_SECONDS=270`
  - `RUN_STALE_TIMEOUT_MINUTES=15`
- secrets:
  - `SESSION_SECRET`
  - `NAVER_CLIENT_ID` (선택)
  - `NAVER_CLIENT_SECRET` (선택)

### 3) 상태 점검 SQL
```sql
-- stale running 유무
SELECT COUNT(*) AS stale_running
FROM poll_runs
WHERE status='running'
  AND datetime(started_at) < datetime('now', '-15 minutes');

-- 최근 실행 상태
SELECT started_at, status, fetched_count, new_article_count, sent_notifications, failed_notifications
FROM poll_runs
ORDER BY started_at DESC
LIMIT 20;

-- 오늘 Naver 사용량
SELECT day, source, used
FROM api_usage_daily
WHERE source='naver_news'
ORDER BY day DESC
LIMIT 7;

-- 현재 락
SELECT name, owner_run_id, acquired_at, expires_at
FROM job_locks
WHERE name='poll';
```

### 4) API 점검
- `GET /api/keywords/:id/diagnose`
  - `stale_dropped > 0`이면 과거기사 차단이 작동 중
  - `naver_remaining_today`로 잔여 예산 확인
- `GET /api/source-health` (admin)
  - lock/stale/예산 상태 요약 확인
