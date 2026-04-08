# Bulk Action 워크플로우

## 전체 흐름도

```
┌──────────┐  submitJob()   ┌─────────────┐  fetchCycle()  ┌───────────┐
│  Client  │ ──────────── → │  Fair Queue  │ ───────────→  │  Admit()  │
└──────────┘  enqueue.lua   │  (SortedSet) │  dequeue.lua  └─────┬─────┘
                            └─────────────┘             ┌────────┴────────┐
                                                        │                 │
                                                  [rate-limit OK]   [rate-limit 초과]
                                                        │                 │
                                                        ▼                 ▼
                                                 Ready Queue       Non-ready Queue
                                                   (List)           (SortedSet)
                                                        │                 │
                                                        │     score ≤ now │
                                                        │   ◄─────────────┘
                                                        │   move-to-ready.lua
                                                        ▼   (DispatcherService)
                                                  ┌───────────┐
                                                  │  Worker   │ BLPOP 대기
                                                  └─────┬─────┘
                                             ┌──────────┼──────────┐
                                             │          │          │
                                        [성공]     [재시도 가능]  [maxRetry 초과]
                                             │     Non-ready로    Dead Letter
                                             │      재진입         Queue
                                             ▼
                                   record-job-result.lua
                                   (successCount/failedCount 기록)
                                             │
                                             ▼
                                         ack.lua
                                   (doneJobs++, 그룹 완료 판정)
                                             │
                                   doneJobs >= totalJobs?
                                        ┌────┴────┐
                                      [Yes]     [No]
                                        │     → 다음 Job 대기
                                        ▼
                                  finalizeGroup()
                            ┌─────────────────────────┐
                            │  RUNNING → AGGREGATING   │
                            │  aggregate() → map/reduce│
                            │  AGGREGATING → COMPLETED │
                            └─────────────────────────┘
```

## 그룹 상태 머신

```
CREATED → DISPATCHED → RUNNING → AGGREGATING → COMPLETED
                 │          │           │
                 └──────────┴───────────┘
                         timeout
                            ↓
                         FAILED
```

---

## Phase 1. 작업 등록 — submitJob() / submitBulkJobs()

**진입점**: `BulkActionService.submitJob()`, `BulkActionService.submitBulkJobs()`

### enqueue.lua (원자적)

```
1. HSET job:{jobId}
   → { id, groupId, processorType, payload, status=PENDING,
      retryCount=0, createdAt=now }

2. RPUSH group:{groupId}:jobs jobId
   → 그룹별 FIFO 작업 목록에 추가

3. HINCRBY group:{groupId}:meta totalJobs 1
   → 첫 Job이면 meta 초기화 (status=CREATED, doneJobs=0, basePriority, priorityLevel)

4. 우선순위 계산
   → score = (-nowMs) + basePriority + α × (-1 + total/remain)
   · α (alpha, default 10000): SJF 부스트 계수
   · 잔여 작업이 적을수록 score↑ → 우선 소비 (SJF)

5. ZADD fair-queue:{level} score groupId
   → level = high | normal | low
```

### submitBulkJobs() 후처리

```
HSET  group:{groupId}:meta registeredJobs {count}     // Watcher CREATED→DISPATCHED 판정용
HSET  group:{groupId}:meta timeoutAt {now + timeoutMs} // 타임아웃 기준
SADD  watcher:active-groups groupId                     // Watcher 감시 등록
```

---

## Phase 2. 작업 인출 + 배압 제어 — FetcherService (매 200ms)

**진입점**: `FetcherService.fetchCycle()` — 배치 최대 50건씩 인출

### 2-1. Ready Queue 여유 확인

가득 차면 (`≥ readyQueueMaxSize`) cycle 종료.

### 2-2. dequeue.lua (원자적)

```
1. HIGH → NORMAL → LOW 순으로 ZREVRANGE 탐색
2. 최고 score 그룹의 group:{groupId}:jobs에서 LPOP
3. HSET job:{jobId} status=PROCESSING
4. 그룹 score 재계산 후 ZADD 갱신 (잔여=0이면 ZREM)
5. HGETALL job:{jobId} 반환
```

### 2-3. BackpressureService.admit(job)

```
├─ rate-limit-check.lua
│   · INCR global counter → globalRps 초과 시 reject
│   · perGroupLimit = floor(globalRps / activeGroups)
│   · INCR group counter → perGroupLimit 초과 시 reject
│
├─ [allowed] → ready-queue-push.lua
│   · LLEN < maxSize 확인 후 RPUSH ready-queue
│
└─ [denied] → congestion-backoff.lua
    · backoffMs = base + floor(nonReady/speed) × 1000
    · ZADD non-ready-queue score=(now + backoffMs)
    · 혼잡도: NONE / LOW / MODERATE / HIGH / CRITICAL
```

---

## Phase 3. 작업 실행 — Worker (workerCount, default 10)

**진입점**: `Worker.tick()` — 각 Worker는 독립 루프로 실행

### 3-1. 작업 수신

```
BLPOP ready-queue (timeout 5s)
→ timeout 시 재대기 (graceful stop 체크 포함)
```

### 3-2. 작업 데이터 로드

```
HGETALL job:{jobId} → Job 데이터 로드
```

### 3-3. 프로세서 실행

```
processorMap[job.processorType].process(job) 실행
→ jobTimeoutMs (default 30s) 초과 시 타임아웃 에러
```

### 3-4. 결과 분기

**성공 (success=true) 또는 재시도 불가 실패**:

```
→ WorkerPoolService.handleJobComplete(result)
  1. record-job-result.lua  (Phase 5에서 상세 설명)
  2. ack.lua                (Phase 5에서 상세 설명)
  3. 그룹 완료 시 → congestion stats 초기화 + finalizeGroup()
```

**실패 (retryable=true, retryCount < maxRetryCount=3)**:

```
→ WorkerPoolService.handleJobFailed(job, error)
  1. HINCRBY job:{jobId} retryCount 1
  2. HSET job:{jobId} status PENDING
  3. BackpressureService.requeue() → Non-ready Queue로 재진입 (backoff 적용)
  4. Phase 4 Dispatcher가 Ready Queue로 복귀시킴
```

**최종 실패 (retryable=false 또는 retryCount >= maxRetryCount)**:

```
→ WorkerPoolService.handleDeadLetter(job, error)
  1. RPUSH dead-letter-queue {job, error, failedAt, retryCount}
  2. HSET job:{jobId} status FAILED
  3. record-job-result.lua (실패로 기록)
  4. ack.lua (그룹 완료 판정 차단 방지)
```

---

## Phase 4. Non-ready → Ready 승격 — DispatcherService (매 100ms)

**진입점**: `DispatcherService.dispatchCycle()`

### move-to-ready.lua (원자적)

```
1. ZRANGEBYSCORE non-ready-queue -inf {now} LIMIT 100
   → backoff 만료된(score ≤ now) 작업 최대 100건 선택

2. 각 jobId에 대해:
   · ZREM non-ready-queue
   · RPUSH ready-queue
   · DECR congestion:{groupId}:non-ready-count

3. Ready Queue에 적재 → Phase 3 Worker가 소비
```

---

## Phase 5. 결과 기록 + 집계 — AggregatorService

**진입점**: `WorkerPoolService.handleJobComplete()` → `AggregatorService.recordJobResult()` → `FairQueueService.ack()`

### 5-1. record-job-result.lua (원자적)

Job 완료 시마다 호출. 성공/실패 카운터와 결과 JSON을 기록한다.

```
1. successCount / failedCount HINCRBY
   → resultType에 따라 group:{groupId}:meta의 카운터 증가

2. RPUSH group:{groupId}:job-results resultJson
   → { jobId, groupId, success, durationMs, error, processorType, data }

3. HSETNX group:{groupId}:meta firstJobStartedAt nowMs
   → 최초 1회만 기록 (DISPATCHED→RUNNING 전이 판정용)

4. HSET group:{groupId}:meta lastUpdatedAt nowMs

5. Read counters → return { isComplete, successCount, failedCount, totalJobs }
   → isComplete: successCount + failedCount >= totalJobs
```

### 5-2. ack.lua (원자적)

Job 완료 처리. doneJobs 카운터 증가와 그룹 완료 판정을 수행한다.

```
1. HSET job:{jobId} status COMPLETED

2. HINCRBY group:{groupId}:meta doneJobs 1

3. doneJobs >= totalJobs ?
   → Yes: HSET group:{groupId}:meta status AGGREGATING → return 1
   → No:  return 0
```

### 5-3. finalizeGroup() — AggregatorService

`ack.lua`가 그룹 완료(`return 1`)를 반환하면 호출된다.
분산 락(`groupAggregationLock`)을 획득한 뒤 double-check 후 실행한다.

```
acquire lock: lock:group:{groupId}:aggregation
│
├─ status == AGGREGATING (ack.lua가 이미 전이)
│   1. aggregate(groupId)
│   2. transition-status.lua: AGGREGATING → COMPLETED
│
├─ status == RUNNING (WatcherService 경유 시)
│   1. transition-status.lua: RUNNING → AGGREGATING
│   2. aggregate(groupId)
│   3. transition-status.lua: AGGREGATING → COMPLETED
│
└─ status == COMPLETED | FAILED → no-op
```

### 5-4. aggregate() — Map/Reduce

```
1. group:{groupId}:job-results에서 배치 로드 (LRANGE, batch=5000)
2. Aggregator.map(jobResult) → 각 결과를 변환
3. Aggregator.reduce(mapped[], context) → 최종 집계
4. HSET group:{groupId}:result result {JSON}
5. HSET group:{groupId}:result aggregatedAt {now}
```

**DefaultAggregator 출력 예시**:

```json
{
  "successCount": 8,
  "failedCount": 2,
  "totalJobs": 10,
  "averageDurationMs": 150,
  "failedJobIds": ["job-3", "job-7"]
}
```

### 5-5. transition-status.lua (원자적)

상태 전이의 원자성을 보장하는 Optimistic Lock 패턴.

```
1. HGET group:{groupId}:meta status
   → currentStatus != fromStatus → return 0 (rejected)

2. HSET status = toStatus, lastUpdatedAt = nowMs

3. 전이별 타임스탬프 기록
   → AGGREGATING: aggregationStartAt = nowMs
   → COMPLETED:   completedAt = nowMs
   → FAILED:      failedAt = nowMs

4. return 1 (success)
```

---

## Redis Key 맵

| Key                                    | Type      | 설명                                                                                                                                      |
| -------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `job:{jobId}`                          | Hash      | Job 데이터 (id, groupId, processorType, payload, status, retryCount, createdAt)                                                           |
| `group:{groupId}:jobs`                 | List      | 그룹 FIFO 작업 목록                                                                                                                       |
| `group:{groupId}:meta`                 | Hash      | 그룹 메타 (totalJobs, doneJobs, registeredJobs, status, successCount, failedCount, firstJobStartedAt, aggregationStartAt, timeoutAt, ...) |
| `group:{groupId}:job-results`          | List      | Job 결과 JSON 목록 (집계용)                                                                                                               |
| `group:{groupId}:result`               | Hash      | 최종 집계 결과 (result, aggregatedAt)                                                                                                     |
| `fair-queue:{high\|normal\|low}`       | SortedSet | 우선순위별 그룹 큐                                                                                                                        |
| `ready-queue`                          | List      | 실행 대기 큐 (BLPOP 소비)                                                                                                                 |
| `non-ready-queue`                      | SortedSet | 배압/혼잡 대기 큐 (score=실행시각)                                                                                                        |
| `rate-limit:{groupId}:{window}`        | String    | 그룹별 Rate Limit 카운터                                                                                                                  |
| `rate-limit:global:{window}`           | String    | 전역 Rate Limit 카운터                                                                                                                    |
| `active-groups`                        | Set       | 활성 그룹 집합                                                                                                                            |
| `congestion:{groupId}:non-ready-count` | String    | 그룹별 Non-ready 작업 수                                                                                                                  |
| `congestion:{groupId}:stats`           | Hash      | 혼잡 통계                                                                                                                                 |
| `dead-letter-queue`                    | List      | 최종 실패 작업                                                                                                                            |
| `lock:group:{groupId}:transition`      | String    | 그룹 전이 분산 락                                                                                                                         |
| `lock:group:{groupId}:aggregation`     | String    | 그룹 집계 분산 락                                                                                                                         |
| `watcher:active-groups`                | Set       | Watcher 감시 대상 그룹                                                                                                                    |
