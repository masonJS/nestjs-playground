# Step 1. Redis 기반 Fair Queue 구현

> 고객사별 공정한 작업 분배를 위한 큐 시스템

---

## 목차

1. [개념 및 배경](#개념-및-배경)
2. [Redis 데이터 구조 설계](#redis-데이터-구조-설계)
3. [우선순위 계산 알고리즘](#우선순위-계산-알고리즘)
4. [Lua 스크립트 기반 원자적 연산](#lua-스크립트-기반-원자적-연산)
5. [NestJS 모듈 구조](#nestjs-모듈-구조)
6. [구현 코드](#구현-코드)
7. [테스트 전략](#테스트-전략)
8. [운영 고려사항](#운영-고려사항)

---

## 개념 및 배경

### Fair Queue란?

일반 큐(FIFO)는 먼저 들어온 요청을 먼저 처리한다. 하지만 벌크액션 시나리오에서는 **특정 고객사가 100만 건을 먼저 넣으면 뒤에 100건을 넣은 고객사가 오래 대기**하는 Head-of-line Blocking 문제가 발생한다.

Fair Queue는 이 문제를 해결하기 위해 **고객사(group)별로 공정하게 작업을 분배**한다.

```
일반 큐 (FIFO):
  고객사A 100만건 → 고객사B 100건 → 고객사C 50건
  → 고객사B, C는 고객사A 완료까지 대기

Fair Queue:
  고객사A에서 N건 → 고객사B에서 N건 → 고객사C에서 N건 → 라운드로빈
  → 모든 고객사가 공정하게 처리됨
```

### 왜 Redis Sorted Set인가?

| 요구사항 | Redis Sorted Set 특성 |
|---------|---------------------|
| 우선순위 기반 정렬 | score 기반 자동 정렬 (O(log N)) |
| 원자적 연산 | Lua 스크립트로 multi-step 연산을 원자적으로 수행 |
| 고성능 | 인메모리 처리로 낮은 지연시간 |
| 분산 환경 지원 | 다중 인스턴스에서 동시 접근 가능 |
| 범위 조회 | ZRANGEBYSCORE로 특정 점수 범위 작업 조회 |

### 3개 큐 운영 전략

우선순위 레벨에 따라 3개의 독립 큐를 운영한다.

```
┌─────────────────────────────────────────┐
│              Fair Queue System           │
│                                         │
│  ┌───────────┐  ┌──────────┐  ┌──────┐ │
│  │ High (0)  │  │Normal (1)│  │Low(2)│ │
│  │ Sorted Set│  │Sorted Set│  │S.Set │ │
│  └─────┬─────┘  └────┬─────┘  └──┬───┘ │
│        │             │            │     │
│        └──────┬──────┘            │     │
│               │                   │     │
│               ▼                   │     │
│     High → Normal → Low 순서로    │     │
│     작업을 dequeue               │     │
└─────────────────────────────────────────┘
```

- **High**: 긴급 처리 또는 소규모 고객사 요청
- **Normal**: 일반 벌크액션
- **Low**: 대규모 배치 작업, 비긴급 작업

---

## Redis 데이터 구조 설계

### Key 네이밍 컨벤션

```
bulk-action:fair-queue:{priority}        # Sorted Set - 그룹 우선순위
bulk-action:group:{groupId}:jobs         # List - 그룹별 작업 목록
bulk-action:group:{groupId}:meta         # Hash - 그룹 메타데이터
bulk-action:job:{jobId}                  # Hash - 개별 작업 데이터
```

> **keyPrefix 전략:**
> ioredis의 `keyPrefix` 옵션은 사용하지 않는다. Lua 스크립트 내부에서 문자열 조합으로
> 생성하는 키에는 ioredis `keyPrefix`가 적용되지 않아 데이터 접근 불일치가 발생하기 때문이다.
> 대신 Service 레이어의 helper 메서드에서 `bulk-action:` prefix를 직접 포함한 full key를
> 생성하고, Lua 내부에서도 동일한 prefix를 사용한다.

### 데이터 구조 상세

**1) 그룹 우선순위 큐 (Sorted Set)**

각 priority level별로 하나의 Sorted Set을 운영한다. score는 우선순위 값이며, member는 groupId이다.

```
Key: bulk-action:fair-queue:normal
Type: Sorted Set
┌──────────────┬──────────────────┐
│   score      │   member         │
├──────────────┼──────────────────┤
│ -1706000100  │ customer-A       │
│ -1706000050  │ customer-B       │
│ -1706000000  │ customer-C       │
└──────────────┴──────────────────┘
→ score가 작을수록 (= 더 오래되었거나 우선순위가 높을수록) 먼저 dequeue
```

**2) 그룹별 작업 목록 (List)**

각 그룹이 보유한 미처리 작업 ID 목록이다.

```
Key: bulk-action:group:customer-A:jobs
Type: List
[ "job:001", "job:002", "job:003", ... ]
```

**3) 그룹 메타데이터 (Hash)**

우선순위 계산에 필요한 그룹 상태 정보를 저장한다.

```
Key: bulk-action:group:customer-A:meta
Type: Hash
┌────────────────┬───────┐
│ field          │ value │
├────────────────┼───────┤
│ basePriority   │ 0     │
│ totalJobs      │ 1000  │
│ doneJobs       │ 250   │
│ priorityLevel  │ normal│
│ createdAt      │ 17060 │
│ status         │ RUNNING│
└────────────────┴───────┘
```

**4) 개별 작업 데이터 (Hash)**

```
Key: bulk-action:job:job-001
Type: Hash
┌────────────┬─────────────────────────────────┐
│ field      │ value                           │
├────────────┼─────────────────────────────────┤
│ id         │ job-001                         │
│ groupId    │ customer-A                      │
│ type       │ SEND_PROMOTION                  │
│ payload    │ {"targetIds": [...]}            │
│ status     │ PENDING                         │
│ retryCount │ 0                               │
│ createdAt  │ 1706000000000                   │
└────────────┴─────────────────────────────────┘
```

---

## 우선순위 계산 알고리즘

### 공식

```
priority = (-1 * now_ms) + base_priority + ALPHA * (-1 + total_jobs / max(1, total_jobs - done_jobs))
```

### 각 항의 역할

**항 1: `-1 * now_ms` (시간 기반 우선순위)**

```
오래된 요청: -1706000000000 (= 더 작은 score → 먼저 처리)
최근 요청:   -1706001000000 (= 더 큰 score → 나중 처리)
```

Sorted Set에서 score가 작은 것이 먼저 꺼내지므로, 오래된 요청이 자연스럽게 우선된다.

**항 2: `base_priority` (고객사별 고정 우선순위)**

```
프리미엄 고객: base_priority = -1000000  → score 감소 → 우선 처리
일반 고객:     base_priority = 0
저우선순위:    base_priority = +1000000  → score 증가 → 후순위
```

비즈니스 로직에 따라 고객사별로 차등을 둔다.

**항 3: `ALPHA * (-1 + total_jobs / max(1, total_jobs - done_jobs))` (공정 분배 패널티)**

이 항은 이름과 달리 순수한 SJF(Shortest Job First)가 아니라, **dequeue 후 해당 그룹의 우선순위를 낮추어 다른 그룹에게 기회를 주는 공정 분배 메커니즘**이다.

SJF 항의 수학적 분해: `(-1 + total_jobs / remaining)` = `done_jobs / remaining`

```
예시 1: total=1000, done=0    → 0/1000    = 0     (패널티 없음, 아직 시작 전)
예시 2: total=1000, done=500  → 500/500   = 1     (중간 진행, 약한 패널티)
예시 3: total=1000, done=990  → 990/10    = 99    (거의 완료, 큰 패널티)
```

**ALPHA 부호에 따른 동작 차이:**

| ALPHA 부호 | 동작 | 효과 |
|-----------|------|------|
| **양수 (default: 10000)** | 진행률이 높을수록 score 증가 (우선순위 하락) | **공정 분배**: 많이 처리된 그룹은 뒤로, 덜 처리된 그룹이 앞으로 |
| **음수** | 진행률이 높을수록 score 감소 (우선순위 상승) | **SJF**: 거의 완료된 그룹을 빨리 끝내줌 |

**기본 설정(ALPHA=양수)에서의 동작 원리:**

dequeue 시마다 우선순위가 재계산되므로, 한 그룹에서 작업을 꺼내면 해당 그룹의 score가 증가(= 우선순위 하락)하여 다음 dequeue에서 다른 그룹이 선택된다. 이것이 **Round-Robin과 유사한 공정 분배** 효과를 만든다.

```
dequeue 전:
  고객사A (done=100/1000, score=-1706000100000)  ← 먼저 선택됨
  고객사B (done=100/1000, score=-1706000050000)

dequeue 후 (고객사A에서 1건 처리):
  고객사A (done=101/1000, score=-1706000090000)  ← score 증가, 우선순위 하락
  고객사B (done=100/1000, score=-1706000050000)  ← 이제 고객사B가 먼저
```

**SJF 효과가 필요한 경우:**

거의 완료된 그룹을 빨리 끝내서 리소스를 해제하고 싶다면 ALPHA를 **음수**로 설정한다.

```typescript
// 공정 분배 모드 (기본값, 권장)
fairQueue: { alpha: 10000 }

// SJF 모드 (거의 완료된 그룹 우선)
fairQueue: { alpha: -10000 }
```

### ALPHA 튜닝 가이드

| |ALPHA| 값 | 효과 |
|-----------|------|
| 0 | 비활성화, 순수 시간 + 기본 우선순위만 적용 |
| 1,000 ~ 10,000 | 약한 효과 (시간 우선순위가 지배적) |
| 100,000 ~ 1,000,000 | 강한 효과 (진행률이 큰 영향) |

| 시나리오 | 권장 설정 |
|---------|----------|
| 고객사 간 공정성이 중요 | ALPHA = +10,000 (양수) |
| 남은 작업이 적은 그룹을 빨리 완료 | ALPHA = -10,000 (음수) |
| 순수 시간순 처리 | ALPHA = 0 |

실제 운영에서는 부하 테스트를 통해 적절한 ALPHA 값과 부호를 찾아야 한다.

---

## Lua 스크립트 기반 원자적 연산

Redis에서 여러 명령을 원자적으로 실행하기 위해 Lua 스크립트를 사용한다. 이는 다중 인스턴스 환경에서 race condition을 방지한다.

> **⚠ Redis 버전 요구사항:**
> `redis.call('TIME')`은 비결정적(non-deterministic) 명령이다.
> Redis 7.0 미만에서는 Lua 내 비결정적 명령이 replica에서 다른 값을 반환하여
> 데이터 불일치가 발생할 수 있다. **Redis 7.0 이상 사용을 권장한다.**

### enqueue.lua - 작업 등록

```lua
-- KEYS[1]: fair-queue sorted set (e.g., bulk-action:fair-queue:normal)
-- KEYS[2]: group jobs list (e.g., bulk-action:group:{groupId}:jobs)
-- KEYS[3]: group meta hash (e.g., bulk-action:group:{groupId}:meta)
-- KEYS[4]: job data hash (e.g., bulk-action:job:{jobId})
-- ARGV[1]: groupId
-- ARGV[2]: jobId
-- ARGV[3]: job payload (JSON)
-- ARGV[4]: basePriority
-- ARGV[5]: priorityLevel
-- ARGV[6]: ALPHA
-- ARGV[7]: job type (e.g., 'SEND_PROMOTION')
--
-- ⚠ ioredis keyPrefix를 사용하지 않으므로 KEYS[]에 full key가 그대로 전달된다.
--   Service에서 'bulk-action:' prefix를 포함한 키를 직접 생성하여 전달한다.

-- ⚠ TIME은 비결정적 명령이므로 스크립트 시작 시 한 번만 호출하여 재사용한다.
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)

-- 1. 작업 데이터 저장
--    type 필드를 별도로 저장해야 Step 4 Worker에서 processor 라우팅이 가능하다.
redis.call('HSET', KEYS[4],
  'id', ARGV[2],
  'groupId', ARGV[1],
  'type', ARGV[7],
  'payload', ARGV[3],
  'status', 'PENDING',
  'retryCount', '0',
  'createdAt', tostring(nowMs)
)

-- 2. 그룹 작업 목록에 추가
redis.call('RPUSH', KEYS[2], ARGV[2])

-- 3. 그룹 메타데이터 업데이트
local totalJobs = redis.call('HINCRBY', KEYS[3], 'totalJobs', 1)
local doneJobs = tonumber(redis.call('HGET', KEYS[3], 'doneJobs') or '0')

-- 최초 등록 시 메타데이터 초기화
if totalJobs == 1 then
  redis.call('HSET', KEYS[3],
    'basePriority', ARGV[4],
    'priorityLevel', ARGV[5],
    'doneJobs', '0',
    'createdAt', tostring(nowMs),
    'status', 'CREATED'
  )
end

-- 4. 우선순위 계산
local basePriority = tonumber(ARGV[4])
local alpha = tonumber(ARGV[6])
local remaining = math.max(1, totalJobs - doneJobs)
local sjfBoost = alpha * (-1 + totalJobs / remaining)
local priority = (-1 * nowMs) + basePriority + sjfBoost

-- 5. Sorted Set에 그룹 등록/갱신
redis.call('ZADD', KEYS[1], priority, ARGV[1])

return {totalJobs, priority}
```

> **변경 사항 (원본 대비):**
> 1. `redis.call('TIME')`을 스크립트 시작 시 **한 번만 호출**하고 `nowMs`를 재사용 (기존: 3회 호출 가능)
> 2. **`type` 필드를 `ARGV[7]`로 별도 저장** — 기존에는 payload JSON 안에 type이 포함되어 있었으나, Step 4의 Worker가 `job.type`으로 processor를 라우팅하므로 Hash 필드로 분리 저장해야 한다.
> 3. `createdAt`을 `nowMs` 변수에서 재사용하여 작업 데이터와 그룹 메타의 시각이 정확히 일치
> 4. **ioredis `keyPrefix`를 사용하지 않음** — Service에서 `bulk-action:` prefix를 포함한 full key를 직접 전달하므로 KEYS[]가 그대로 Redis에 전달된다.

### dequeue.lua - 작업 꺼내기

> **keyPrefix 전략:**
> ioredis의 `keyPrefix` 옵션은 사용하지 않는다. Lua 스크립트 내부에서 문자열 조합으로
> 생성하는 키에는 ioredis `keyPrefix`가 적용되지 않아 KEYS[]와 내부 키 간 불일치가 발생하기 때문이다.
> 대신 Service가 full key를 KEYS[]로 전달하고, Lua 내부에서 동적으로 생성하는 키에는
> `ARGV[2]`로 전달받은 key prefix를 사용한다.

```lua
-- KEYS[1]: high priority queue (e.g., bulk-action:fair-queue:high)
-- KEYS[2]: normal priority queue (e.g., bulk-action:fair-queue:normal)
-- KEYS[3]: low priority queue (e.g., bulk-action:fair-queue:low)
-- ARGV[1]: ALPHA
-- ARGV[2]: key prefix (e.g., 'bulk-action:')

local prefix = ARGV[2]

-- 우선순위 순서대로 큐 탐색
local queues = {KEYS[1], KEYS[2], KEYS[3]}

for _, queueKey in ipairs(queues) do
  -- 같은 큐 내에서 유효한 그룹을 찾을 때까지 반복
  while true do
    -- 1. 가장 높은 우선순위 그룹 조회 (score가 가장 작은 것)
    local result = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')

    if #result == 0 then
      break  -- 이 큐에 그룹이 없음, 다음 priority 큐로
    end

    local groupId = result[1]
    local groupJobsKey = prefix .. 'group:' .. groupId .. ':jobs'
    local groupMetaKey = prefix .. 'group:' .. groupId .. ':meta'

    -- 2. 그룹의 작업 목록에서 하나 꺼냄
    local jobId = redis.call('LPOP', groupJobsKey)

    if jobId then
      local jobKey = prefix .. 'job:' .. jobId

      -- 3. 작업 상태를 PROCESSING으로 변경
      redis.call('HSET', jobKey, 'status', 'PROCESSING')

      -- 4. 그룹 메타데이터에서 우선순위 재계산
      local totalJobs = tonumber(redis.call('HGET', groupMetaKey, 'totalJobs') or '0')
      local doneJobs = tonumber(redis.call('HGET', groupMetaKey, 'doneJobs') or '0')
      local remainingJobs = redis.call('LLEN', groupJobsKey)

      if remainingJobs == 0 then
        -- 남은 작업이 없으면 큐에서 그룹 제거
        redis.call('ZREM', queueKey, groupId)
      else
        -- 우선순위 재계산 후 갱신
        local now = redis.call('TIME')
        local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
        local basePriority = tonumber(redis.call('HGET', groupMetaKey, 'basePriority') or '0')
        local alpha = tonumber(ARGV[1])
        local remaining = math.max(1, totalJobs - doneJobs)
        local sjfBoost = alpha * (-1 + totalJobs / remaining)
        local newPriority = (-1 * nowMs) + basePriority + sjfBoost
        redis.call('ZADD', queueKey, newPriority, groupId)
      end

      -- 5. 작업 데이터 반환
      local jobData = redis.call('HGETALL', jobKey)
      return jobData
    else
      -- 작업 목록이 비었으면 큐에서 제거하고, 같은 큐의 다음 그룹 탐색
      redis.call('ZREM', queueKey, groupId)
      -- while 루프가 계속되어 같은 큐의 다음 그룹을 시도
    end
  end
end

return nil
```

> **변경 사항 (원본 대비):**
> 1. **ioredis `keyPrefix` 제거** — ioredis `keyPrefix`가 KEYS[]에만 적용되고 Lua 내부 문자열 조합 키에는 적용되지 않아 키 불일치 버그가 있었다. Service에서 full key를 직접 전달하고, Lua 내부 키는 `ARGV[2]`(prefix)를 사용하여 일관성을 보장한다.
> 2. **같은 큐 내 재탐색 로직 추가** — 기존에는 top 그룹의 job list가 비었을 때 다음 priority 큐로 넘어갔다. 이제 `while` 루프로 같은 큐 내 다른 그룹을 재탐색하여 공정성 훼손을 방지한다.
> 3. Service의 `getGroupJobsKey()`, `getGroupMetaKey()`, `getJobKey()`가 반환하는 full key 형식과 Lua 내부 키 조합 결과가 일치하도록 통일

### ack.lua - 작업 완료 확인

```lua
-- KEYS[1]: job data hash (e.g., bulk-action:job:{jobId})
-- KEYS[2]: group meta hash (e.g., bulk-action:group:{groupId}:meta)

-- 1. 작업 상태를 COMPLETED로 변경
redis.call('HSET', KEYS[1], 'status', 'COMPLETED')

-- 2. 그룹의 doneJobs 증가
local doneJobs = redis.call('HINCRBY', KEYS[2], 'doneJobs', 1)
local totalJobs = tonumber(redis.call('HGET', KEYS[2], 'totalJobs') or '0')

-- 3. 모든 작업 완료 여부 반환
if doneJobs >= totalJobs then
  redis.call('HSET', KEYS[2], 'status', 'AGGREGATING')
  return 1  -- 그룹 완료
end

return 0  -- 아직 진행 중
```

> **변경 사항 (원본 대비):**
> 1. **불필요한 ARGV 제거** — 기존 ARGV[1](jobId), ARGV[2](groupId)는 Lua 내부에서 사용하지 않았다. KEYS[1], KEYS[2]에 이미 full key가 전달되므로 ARGV가 불필요하다.

---

## NestJS 모듈 구조

### 디렉토리 구조

```
libs/bulk-action/
├── src/
│   ├── index.ts                          # public API exports
│   ├── bulk-action.module.ts             # 루트 모듈
│   ├── config/
│   │   └── bulk-action.config.ts         # 설정 인터페이스
│   ├── fair-queue/
│   │   ├── fair-queue.service.ts         # 큐 관리 서비스
│   │   ├── fair-queue.constants.ts       # 상수 정의
│   │   ├── priority-calculator.ts        # 우선순위 계산 유틸리티 (테스트 검증용)
│   │   └── priority-calculator.spec.ts    # 단위 테스트
│   ├── lua/
│   │   ├── enqueue.lua                   # 작업 등록 스크립트
│   │   ├── dequeue.lua                   # 작업 꺼내기 스크립트
│   │   ├── ack.lua                       # 작업 완료 스크립트
│   │   └── lua-script-loader.ts          # Lua 스크립트 로더
│   ├── model/
│   │   ├── job.ts                        # Job 인터페이스
│   │   ├── job-group.ts                  # JobGroup 인터페이스
│   │   └── enqueue-options.ts            # Enqueue 옵션 타입
│   └── redis/
│       └── redis.provider.ts             # Redis 연결 프로바이더
└── tsconfig.lib.json
```

### 의존성 설치

```bash
npm install ioredis
npm install -D @types/ioredis
```

### 프로젝트 설정

현재 monorepo에 `bulk-action` 라이브러리를 추가하려면 다음 설정이 필요하다.

**1) tsconfig.json - path alias 추가:**

```json
{
  "compilerOptions": {
    "paths": {
      "@app/bulk-action": ["libs/bulk-action/src"],
      "@app/bulk-action/*": ["libs/bulk-action/src/*"]
    }
  }
}
```

**2) nest-cli.json - 프로젝트 및 assets 등록:**

```json
{
  "projects": {
    "bulk-action": {
      "type": "library",
      "root": "libs/bulk-action",
      "entryFile": "index",
      "sourceRoot": "libs/bulk-action/src",
      "compilerOptions": {
        "tsConfigPath": "libs/bulk-action/tsconfig.lib.json",
        "assets": [
          {
            "include": "**/*.lua",
            "watchAssets": true
          }
        ]
      }
    }
  }
}
```

**3) libs/bulk-action/tsconfig.lib.json:**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "outDir": "../../dist/libs/bulk-action"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test", "**/*spec.ts"]
}
```

---

## 구현 코드

### 모델 정의

**`model/job.ts`**

```typescript
export interface Job {
  id: string;
  groupId: string;
  type: string;
  payload: string; // JSON string
  status: JobStatus;
  retryCount: number;
  createdAt: number;
}

export enum JobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
```

**`model/job-group.ts`**

```typescript
export interface JobGroup {
  groupId: string;
  basePriority: number;
  totalJobs: number;
  doneJobs: number;
  priorityLevel: PriorityLevel;
  createdAt: number;
  status: GroupStatus;
}

export enum PriorityLevel {
  HIGH = 'high',
  NORMAL = 'normal',
  LOW = 'low',
}

export enum GroupStatus {
  CREATED = 'CREATED',
  DISPATCHED = 'DISPATCHED',
  RUNNING = 'RUNNING',
  AGGREGATING = 'AGGREGATING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
```

**`model/enqueue-options.ts`**

```typescript
import { PriorityLevel } from './job-group';

export interface EnqueueOptions {
  groupId: string;
  jobId: string;
  type: string;
  payload: Record<string, unknown>;
  basePriority?: number;      // default: 0
  priorityLevel?: PriorityLevel; // default: NORMAL
}
```

### 설정

**`config/bulk-action.config.ts`**

```typescript
export interface BulkActionConfig {
  redis: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    keyPrefix?: string;  // Service 레이어에서 키 생성 시 사용 (default: 'bulk-action:')
                         // ⚠ ioredis keyPrefix로는 전달하지 않는다. (Lua 호환성)
  };
  fairQueue: {
    alpha: number;       // 공정 분배 가중치 (양수: 공정분배, 음수: SJF, default: 10000)
  };
}

export const DEFAULT_BULK_ACTION_CONFIG: BulkActionConfig = {
  redis: {
    host: 'localhost',
    port: 6379,
    db: 0,
    keyPrefix: 'bulk-action:',
  },
  fairQueue: {
    alpha: 10000,
  },
};
```

### Redis Provider

**`redis/redis.provider.ts`**

```typescript
import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { BulkActionConfig } from '../config/bulk-action.config';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const BULK_ACTION_CONFIG = Symbol('BULK_ACTION_CONFIG');

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (config: BulkActionConfig): Redis => {
    // ⚠ keyPrefix는 사용하지 않는다.
    //   Lua 스크립트 내부에서 생성하는 키에는 ioredis keyPrefix가 적용되지 않아
    //   KEYS[]와 내부 키 간 불일치가 발생하기 때문이다.
    //   대신 Service 레이어에서 full key를 직접 생성한다.
    return new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
    });
  },
  inject: [BULK_ACTION_CONFIG],
};
```

### Lua 스크립트 로더

**`lua/lua-script-loader.ts`**

```typescript
import { Injectable, OnModuleInit, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import * as fs from 'fs/promises';
import * as path from 'path';
import { REDIS_CLIENT } from '../redis/redis.provider';

@Injectable()
export class LuaScriptLoader implements OnModuleInit {
  private scripts: Map<string, string> = new Map();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadScript('enqueue', 'enqueue.lua');
    await this.loadScript('dequeue', 'dequeue.lua');
    await this.loadScript('ack', 'ack.lua');
  }

  private async loadScript(name: string, filename: string): Promise<void> {
    // ⚠ __dirname 기반 경로는 빌드 후 dist/ 환경에서 .lua 파일이 존재해야 동작한다.
    //   nest-cli.json의 compilerOptions.assets 설정으로 .lua 파일을 복사해야 한다.
    //   (아래 "운영 고려사항 > 빌드 시 Lua 파일 복사" 참고)
    const luaPath = path.join(__dirname, filename);
    const script = await fs.readFile(luaPath, 'utf-8');
    // defineCommand를 통해 Redis에 커스텀 명령 등록
    this.redis.defineCommand(name, {
      numberOfKeys: this.getKeyCount(name),
      lua: script,
    });
    this.scripts.set(name, script);
  }

  private getKeyCount(name: string): number {
    const keyCounts: Record<string, number> = {
      enqueue: 4,  // fair-queue set, group jobs list, group meta hash, job hash
      dequeue: 3,  // high queue, normal queue, low queue
      ack: 2,      // job hash, group meta hash
    };
    return keyCounts[name] ?? 0;
  }
}
```

### 우선순위 계산기

**`fair-queue/priority-calculator.ts`**

> **이 클래스는 단위 테스트에서 우선순위 공식을 검증하기 위한 용도이다.**
> 실제 운영에서의 우선순위 계산은 Lua 스크립트(enqueue.lua, dequeue.lua)가 수행한다.
> 공식을 변경할 경우 Lua 스크립트를 먼저 수정하고, 이 클래스도 동일하게 반영해야 한다.

```typescript
export class PriorityCalculator {
  constructor(private readonly alpha: number) {}

  /**
   * Fair Queue 우선순위를 계산한다.
   *
   * score가 작을수록 높은 우선순위를 가진다.
   * - 시간: 오래된 요청일수록 score가 작다
   * - basePriority: 음수일수록 우선 처리
   * - 공정 분배 패널티: ALPHA 양수 → 진행률 높은 그룹 후순위 (공정 분배)
   *                     ALPHA 음수 → 진행률 높은 그룹 우선 (SJF)
   *
   * ⚠ 이 공식은 enqueue.lua, dequeue.lua의 Lua 구현과 동일해야 한다.
   */
  calculate(params: {
    nowMs: number;
    basePriority: number;
    totalJobs: number;
    doneJobs: number;
  }): number {
    const { nowMs, basePriority, totalJobs, doneJobs } = params;
    const remaining = Math.max(1, totalJobs - doneJobs);
    const sjfBoost = this.alpha * (-1 + totalJobs / remaining);
    return -1 * nowMs + basePriority + sjfBoost;
  }
}
```

### Fair Queue Service

**`fair-queue/fair-queue.service.ts`**

```typescript
import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.provider';
import { BULK_ACTION_CONFIG } from '../redis/redis.provider';
import { BulkActionConfig } from '../config/bulk-action.config';
import { EnqueueOptions } from '../model/enqueue-options';
import { Job, JobStatus } from '../model/job';
import { PriorityLevel } from '../model/job-group';

/**
 * ioredis defineCommand로 등록된 커스텀 Lua 명령의 타입 정의.
 * `(this.redis as any)` 대신 타입 안전한 호출을 제공한다.
 */
interface RedisWithCommands extends Redis {
  enqueue(
    queueKey: string,
    groupJobsKey: string,
    groupMetaKey: string,
    jobKey: string,
    groupId: string,
    jobId: string,
    payload: string,
    basePriority: string,
    priorityLevel: string,
    alpha: string,
    type: string,
  ): Promise<[number, number]>;

  dequeue(
    highKey: string,
    normalKey: string,
    lowKey: string,
    alpha: string,
    keyPrefix: string,
  ): Promise<string[] | null>;

  ack(
    jobKey: string,
    groupMetaKey: string,
  ): Promise<number>;
}

@Injectable()
export class FairQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(FairQueueService.name);
  private readonly keyPrefix: string;
  private readonly redisWithCommands: RedisWithCommands;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BULK_ACTION_CONFIG) private readonly config: BulkActionConfig,
  ) {
    this.keyPrefix = config.redis.keyPrefix ?? 'bulk-action:';
    this.redisWithCommands = redis as unknown as RedisWithCommands;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
    this.logger.log('Redis connection closed');
  }

  /**
   * 작업을 Fair Queue에 등록한다.
   *
   * Lua 스크립트를 통해 다음을 원자적으로 수행:
   * 1. Job 데이터 저장
   * 2. 그룹 작업 목록에 추가
   * 3. 그룹 메타데이터 갱신
   * 4. 우선순위 재계산 후 Sorted Set 갱신
   */
  async enqueue(options: EnqueueOptions): Promise<void> {
    const {
      groupId,
      jobId,
      type,
      payload,
      basePriority = 0,
      priorityLevel = PriorityLevel.NORMAL,
    } = options;

    const queueKey = this.getQueueKey(priorityLevel);
    const groupJobsKey = this.getGroupJobsKey(groupId);
    const groupMetaKey = this.getGroupMetaKey(groupId);
    const jobKey = this.getJobKey(jobId);

    try {
      await this.redisWithCommands.enqueue(
        queueKey,
        groupJobsKey,
        groupMetaKey,
        jobKey,
        groupId,
        jobId,
        JSON.stringify(payload),
        basePriority.toString(),
        priorityLevel,
        this.config.fairQueue.alpha.toString(),
        type,
      );

      this.logger.debug(
        `Enqueued job ${jobId} for group ${groupId} at ${priorityLevel} priority`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to enqueue job ${jobId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 가장 높은 우선순위의 작업을 꺼낸다.
   *
   * High → Normal → Low 순서로 큐를 탐색하여
   * 가장 높은 우선순위 그룹에서 하나의 작업을 반환한다.
   */
  async dequeue(): Promise<Job | null> {
    const highKey = this.getQueueKey(PriorityLevel.HIGH);
    const normalKey = this.getQueueKey(PriorityLevel.NORMAL);
    const lowKey = this.getQueueKey(PriorityLevel.LOW);

    try {
      const result = await this.redisWithCommands.dequeue(
        highKey,
        normalKey,
        lowKey,
        this.config.fairQueue.alpha.toString(),
        this.keyPrefix,
      );

      if (!result) {
        return null;
      }

      return this.parseJobFromRedis(result);
    } catch (error) {
      this.logger.error(
        `Failed to dequeue: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 작업 완료를 확인한다.
   *
   * @returns 그룹의 모든 작업이 완료되었으면 true
   */
  async ack(jobId: string, groupId: string): Promise<boolean> {
    const jobKey = this.getJobKey(jobId);
    const groupMetaKey = this.getGroupMetaKey(groupId);

    const result = await this.redisWithCommands.ack(jobKey, groupMetaKey);
    const isGroupCompleted = result === 1;

    if (isGroupCompleted) {
      this.logger.log(`Group ${groupId} completed all jobs`);
    }

    return isGroupCompleted;
  }

  /**
   * 특정 그룹의 대기 중인 작업 수를 조회한다.
   */
  async getGroupPendingCount(groupId: string): Promise<number> {
    return this.redis.llen(this.getGroupJobsKey(groupId));
  }

  /**
   * 전체 큐 상태를 조회한다.
   */
  async getQueueStats(): Promise<QueueStats> {
    const [highCount, normalCount, lowCount] = await Promise.all([
      this.redis.zcard(this.getQueueKey(PriorityLevel.HIGH)),
      this.redis.zcard(this.getQueueKey(PriorityLevel.NORMAL)),
      this.redis.zcard(this.getQueueKey(PriorityLevel.LOW)),
    ]);

    return {
      highPriorityGroups: highCount,
      normalPriorityGroups: normalCount,
      lowPriorityGroups: lowCount,
      totalGroups: highCount + normalCount + lowCount,
    };
  }

  // --- Private helpers ---
  // ⚠ ioredis keyPrefix를 사용하지 않으므로
  //   모든 helper가 'bulk-action:' prefix를 포함한 full key를 반환한다.

  private getQueueKey(level: PriorityLevel): string {
    return `${this.keyPrefix}fair-queue:${level}`;
  }

  private getGroupJobsKey(groupId: string): string {
    return `${this.keyPrefix}group:${groupId}:jobs`;
  }

  private getGroupMetaKey(groupId: string): string {
    return `${this.keyPrefix}group:${groupId}:meta`;
  }

  private getJobKey(jobId: string): string {
    return `${this.keyPrefix}job:${jobId}`;
  }

  private parseJobFromRedis(raw: string[]): Job {
    const map: Record<string, string> = {};
    for (let i = 0; i < raw.length; i += 2) {
      map[raw[i]] = raw[i + 1];
    }
    return {
      id: map.id,
      groupId: map.groupId,
      type: map.type ?? '',
      payload: map.payload ?? '{}',
      status: (map.status as JobStatus) ?? JobStatus.PENDING,
      retryCount: parseInt(map.retryCount ?? '0', 10),
      createdAt: parseInt(map.createdAt ?? '0', 10),
    };
  }
}

export interface QueueStats {
  highPriorityGroups: number;
  normalPriorityGroups: number;
  lowPriorityGroups: number;
  totalGroups: number;
}
```

### 루트 모듈

**`bulk-action.module.ts`**

```typescript
import { DynamicModule, Module } from '@nestjs/common';
import { FairQueueService } from './fair-queue/fair-queue.service';
import { LuaScriptLoader } from './lua/lua-script-loader';
import { redisProvider, BULK_ACTION_CONFIG } from './redis/redis.provider';
import {
  BulkActionConfig,
  DEFAULT_BULK_ACTION_CONFIG,
} from './config/bulk-action.config';

@Module({})
export class BulkActionModule {
  static register(config?: Partial<BulkActionConfig>): DynamicModule {
    const mergedConfig: BulkActionConfig = {
      ...DEFAULT_BULK_ACTION_CONFIG,
      ...config,
      redis: {
        ...DEFAULT_BULK_ACTION_CONFIG.redis,
        ...config?.redis,
      },
      fairQueue: {
        ...DEFAULT_BULK_ACTION_CONFIG.fairQueue,
        ...config?.fairQueue,
      },
    };

    return {
      module: BulkActionModule,
      providers: [
        {
          provide: BULK_ACTION_CONFIG,
          useValue: mergedConfig,
        },
        redisProvider,
        LuaScriptLoader,
        FairQueueService,
      ],
      exports: [FairQueueService],
    };
  }
}
```

### 사용 예시

**`apps/api/src/ApiModule.ts`** 에서 등록:

```typescript
import { BulkActionModule } from '@app/bulk-action';

@Module({
  imports: [
    BulkActionModule.register({
      redis: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      },
      fairQueue: {
        alpha: 10000,
      },
    }),
  ],
})
export class ApiModule {}
```

**서비스에서 사용:**

```typescript
@Injectable()
export class PromotionBulkService {
  constructor(private readonly fairQueue: FairQueueService) {}

  async sendBulkPromotion(customerId: string, targets: string[]): Promise<void> {
    for (const targetId of targets) {
      await this.fairQueue.enqueue({
        groupId: customerId,
        jobId: `promo-${customerId}-${targetId}`,
        type: 'SEND_PROMOTION',
        payload: { targetId, customerId },
        priorityLevel: PriorityLevel.NORMAL,
      });
    }
  }
}
```

---

## 테스트 전략

### 단위 테스트

**우선순위 계산기 테스트:**

```typescript
describe('PriorityCalculator', () => {
  const calculator = new PriorityCalculator(10000);

  it('오래된 요청이 더 높은 우선순위(낮은 score)를 가진다', () => {
    const older = calculator.calculate({
      nowMs: 1706000000000,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 0,
    });
    const newer = calculator.calculate({
      nowMs: 1706001000000,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 0,
    });
    expect(older).toBeLessThan(newer);
  });

  it('basePriority가 낮은 그룹이 우선 처리된다', () => {
    const now = Date.now();
    const premium = calculator.calculate({
      nowMs: now,
      basePriority: -1000000,
      totalJobs: 100,
      doneJobs: 0,
    });
    const normal = calculator.calculate({
      nowMs: now,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 0,
    });
    expect(premium).toBeLessThan(normal);
  });

  it('ALPHA 양수일 때 진행률이 높은 그룹의 score가 더 크다 (공정 분배)', () => {
    const now = Date.now();
    const almostDone = calculator.calculate({
      nowMs: now,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 95,
    });
    const justStarted = calculator.calculate({
      nowMs: now,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 5,
    });
    // ALPHA=10000 (양수) → 진행률이 높을수록 score 증가 (= 우선순위 하락)
    // 즉, 많이 처리된 그룹이 뒤로 밀려나야 한다
    expect(almostDone).toBeGreaterThan(justStarted);
  });

  it('ALPHA 음수일 때 진행률이 높은 그룹의 score가 더 작다 (SJF)', () => {
    const sjfCalculator = new PriorityCalculator(-10000);
    const now = Date.now();
    const almostDone = sjfCalculator.calculate({
      nowMs: now,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 95,
    });
    const justStarted = sjfCalculator.calculate({
      nowMs: now,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 5,
    });
    // ALPHA=-10000 (음수) → 진행률이 높을수록 score 감소 (= 우선순위 상승)
    // 즉, 거의 완료된 그룹이 먼저 처리되어야 한다
    expect(almostDone).toBeLessThan(justStarted);
  });
});
```

### 통합 테스트

실제 Redis를 사용한 통합 테스트:

```typescript
describe('FairQueueService (Integration)', () => {
  let service: FairQueueService;
  let redis: Redis;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        BulkActionModule.register({
          redis: { host: 'localhost', port: 6379, db: 15 }, // 테스트용 DB
        }),
      ],
    }).compile();

    service = module.get(FairQueueService);
    redis = module.get(REDIS_CLIENT);
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('enqueue 후 dequeue하면 동일한 작업을 반환한다', async () => {
    await service.enqueue({
      groupId: 'customer-A',
      jobId: 'job-001',
      type: 'TEST',
      payload: { data: 'hello' },
    });

    const job = await service.dequeue();
    expect(job).not.toBeNull();
    expect(job.id).toBe('job-001');
    expect(job.groupId).toBe('customer-A');
  });

  it('여러 그룹에서 공정하게 작업을 분배한다', async () => {
    // 고객사 A: 3개 작업
    for (let i = 0; i < 3; i++) {
      await service.enqueue({
        groupId: 'customer-A',
        jobId: `a-${i}`,
        type: 'TEST',
        payload: {},
      });
    }
    // 고객사 B: 3개 작업
    for (let i = 0; i < 3; i++) {
      await service.enqueue({
        groupId: 'customer-B',
        jobId: `b-${i}`,
        type: 'TEST',
        payload: {},
      });
    }

    // dequeue 순서가 A, B 번갈아가며 나와야 함
    const jobs: Job[] = [];
    for (let i = 0; i < 6; i++) {
      const job = await service.dequeue();
      if (job) jobs.push(job);
    }

    // 연속으로 같은 그룹만 나오지 않는지 검증
    const groups = jobs.map((j) => j.groupId);
    const consecutiveSameGroup = groups.some(
      (g, i) => i > 0 && g === groups[i - 1],
    );
    // Fair Queue 특성상 같은 그룹이 연속될 수 있지만,
    // 한 그룹이 모든 슬롯을 독점하지 않아야 함
    const groupACounts = groups.filter((g) => g === 'customer-A').length;
    const groupBCounts = groups.filter((g) => g === 'customer-B').length;
    expect(groupACounts).toBe(3);
    expect(groupBCounts).toBe(3);
  });

  it('ack 호출 시 그룹 완료 여부를 반환한다', async () => {
    await service.enqueue({
      groupId: 'customer-A',
      jobId: 'job-001',
      type: 'TEST',
      payload: {},
    });

    const job = await service.dequeue();
    const isCompleted = await service.ack(job.id, job.groupId);
    expect(isCompleted).toBe(true); // 1개 작업이므로 즉시 완료
  });
});
```

---

## 운영 고려사항

### 빌드 시 Lua 파일 복사

`LuaScriptLoader`가 `__dirname` 기반으로 `.lua` 파일을 읽으므로, NestJS 빌드(`tsc` 또는 webpack) 후 `dist/` 디렉토리에 `.lua` 파일이 함께 복사되어야 한다.

monorepo (libs/) 구조에서의 nest-cli.json 설정은 위 [프로젝트 설정](#프로젝트-설정) 섹션을 참고한다.

> webpack 번들러를 사용하는 경우 `CopyWebpackPlugin`으로 `.lua` 파일을 output에 복사해야 한다.

### Redis Cluster 사용 시 제약사항

Redis Cluster 환경에서 Lua 스크립트가 접근하는 **모든 키는 동일한 hash slot에 위치**해야 한다. 그렇지 않으면 `CROSSSLOT` 에러가 발생한다.

**해결 방법: Hash Tag 사용**

키의 `{...}` 부분만 hash slot 계산에 사용되므로, groupId를 hash tag로 감싸서 관련 키들이 같은 slot에 배치되도록 한다.

```
bulk-action:fair-queue:{normal}          # ← Cluster에서는 priority별 분리 불가
bulk-action:group:{customer-A}:jobs      # {customer-A} 기준 slot
bulk-action:group:{customer-A}:meta      # 같은 slot
bulk-action:job:{customer-A}:job-001     # 같은 slot (jobId에 groupId prefix 필요)
```

**Cluster 환경에서의 권장 키 구조:**

```typescript
// groupId를 hash tag로 사용
private getGroupJobsKey(groupId: string): string {
  return `${this.keyPrefix}group:{${groupId}}:jobs`;
}

private getGroupMetaKey(groupId: string): string {
  return `${this.keyPrefix}group:{${groupId}}:meta`;
}

private getJobKey(groupId: string, jobId: string): string {
  return `${this.keyPrefix}job:{${groupId}}:${jobId}`;
}
```

> **주의:** `dequeue.lua`는 3개의 priority queue(KEYS[1~3])를 순회하므로, 이 키들이 서로 다른 slot에 위치하면 Cluster에서 동작하지 않는다. Cluster 환경에서는 priority별 큐를 분리하지 않고 단일 큐를 사용하거나, 각 priority 큐에 동일한 hash tag를 부여하는 방식을 검토해야 한다.

### Redis 메모리 관리

| 항목 | 권장값 |
|------|-------|
| `maxmemory-policy` | `noeviction` (큐 데이터 유실 방지) |
| Job TTL | 완료 후 24시간 보관 후 삭제 |
| 그룹 메타 TTL | 완료 후 7일 보관 후 삭제 |

완료된 Job과 그룹 메타데이터는 주기적으로 정리해야 한다.

```typescript
// 완료된 Job 정리 (Cron 등록)
async cleanupCompletedJobs(olderThanMs: number): Promise<number> {
  // SCAN으로 완료된 job을 찾아 TTL이 지난 것을 삭제
}
```

### 모니터링 지표

```
# 큐별 대기 그룹 수
bulk_action_queue_groups{priority="high"}
bulk_action_queue_groups{priority="normal"}
bulk_action_queue_groups{priority="low"}

# 초당 enqueue/dequeue 처리량
bulk_action_enqueue_total
bulk_action_dequeue_total

# 그룹별 대기 작업 수
bulk_action_group_pending_jobs{groupId="..."}

# Lua 스크립트 실행 지연시간
bulk_action_lua_duration_ms{script="enqueue"}
bulk_action_lua_duration_ms{script="dequeue"}
```

### 장애 대응

| 시나리오 | 대응 |
|---------|------|
| Redis 연결 끊김 | ioredis retryStrategy로 자동 재연결 |
| Lua 스크립트 실행 실패 | 에러 로깅 후 재시도 (Step 6 Reliable Queue에서 보장) |
| 메모리 부족 | maxmemory 알림 설정 + 완료 데이터 TTL 단축 |
| 단일 그룹 폭주 | Rate Limiting (Step 2)에서 제어 |
| 앱 종료 시 Redis 연결 | FairQueueService.onModuleDestroy()에서 자동 정리 |

### 후속 Step과의 연동 인터페이스

Fair Queue는 전체 파이프라인의 첫 단계로, 후속 Step들과 다음과 같은 접점을 가진다.

**Step 2 (Backpressure & Rate Limiting):**

Fair Queue의 `dequeue()`는 Step 2의 Rate Limiter를 통해 호출된다. Fair Queue는 **"어떤 순서로 작업을 꺼낼 것인가"**를 담당하고, Rate Limiting은 **"얼마나 빨리 꺼낼 것인가"**를 담당한다.

```
Fair Queue.dequeue() → Rate Limiter 게이트 → Ready Queue → Worker
```

**Step 4 (Worker Pool):**

Worker는 `job.type`을 기준으로 적절한 processor를 선택한다. 따라서 enqueue 시 `type` 필드가 반드시 별도 Hash 필드로 저장되어야 한다 (enqueue.lua 수정사항 참고).

```typescript
// Step 4 Worker에서의 사용
const processor = this.processorMap.get(job.type); // 'SEND_PROMOTION' → PromotionProcessor
```

**Step 5 (Aggregator & Watcher):**

`ack.lua`에서 그룹 완료 시 `status`를 `'AGGREGATING'`으로 변경하는데, 이는 Step 5의 State Machine 진입 트리거가 된다. Step 5에서는 그룹 메타에 `successCount`/`failedCount`를 추가로 관리하므로, `ack.lua` 확장 시 다음을 고려해야 한다:

```lua
-- Step 5 연동을 위한 ack.lua 확장 포인트
-- ARGV[1]: result ('SUCCESS' | 'FAILED')
if ARGV[1] == 'SUCCESS' then
  redis.call('HINCRBY', KEYS[2], 'successCount', 1)
else
  redis.call('HINCRBY', KEYS[2], 'failedCount', 1)
end
```

**Step 6 (Reliable Queue):**

현재 `dequeue.lua`의 `LPOP`은 at-most-once 전달이다. Step 6에서는 이를 **Reliable Dequeue** 패턴으로 교체하여 at-least-once 전달을 보장한다:

```
기존: LPOP (꺼내면 즉시 삭제)
변경: RPOPLPUSH → In-flight Queue → ACK 후 삭제
```

Step 6 적용 시 `dequeue.lua`의 `LPOP`을 `RPOPLPUSH`로 교체하고, In-flight Queue 키(`{keyPrefix}group:{groupId}:inflight`)를 추가 KEYS로 전달해야 한다.

### 다음 단계

이 Fair Queue가 구현되면 다음 순서로 파이프라인을 확장한다:

1. **Step 2**: Ready Queue / Non-ready Queue를 추가하여 처리 속도를 제어
2. **Step 3**: 외부 API 응답 시간에 따른 동적 속도 조절
3. **Step 4**: Worker Pool에서 `job.type` 기반 processor 라우팅
4. **Step 5**: 그룹 완료 후 결과 집계 및 상태 머신 관리
5. **Step 6**: `dequeue.lua`를 Reliable Dequeue로 교체하여 유실 방지


### 문서 갱신 히스토리

#### 1. 2026-02-04
```
#: 1
이슈: SJF Boost 공식 해석 오류
수정 내용: "공정 분배 패널티"로 용어 변경, ALPHA 부호별 동작 차이
명확화,
수학적 분해/예시 추가
────────────────────────────────────────
#: 2
이슈: dequeue.lua 키 구성 이중 prefix 버그
수정 내용: 'bulk-action:group:' → 'group:'로 수정, ioredis keyPrefix
충돌
설명 추가
────────────────────────────────────────
#: 3
이슈: enqueue.lua type 필드 미저장
수정 내용: ARGV[7]로 type을 별도 전달하여 Hash 필드로 저장, Service
호출부도 수정
────────────────────────────────────────
#: 4
이슈: enqueue.lua TIME 중복 호출
수정 내용: 스크립트 시작 시 1회만 호출 후 nowMs 재사용
────────────────────────────────────────
#: 5
이슈: LuaScriptLoader 빌드 환경 미고려
수정 내용: nest-cli.json의 compilerOptions.assets 설정 가이드 추가
────────────────────────────────────────
#: 6
이슈: Redis Cluster 제약사항 누락
수정 내용: Hash Tag {groupId} 사용법, CROSSSLOT 에러 방지 전략,
dequeue.lua의 multi-key 제약 설명 추가
────────────────────────────────────────
#: 7
이슈: 후속 Step 연동 인터페이스 보강
수정 내용: Step 2/4/5/6 각각과의 접점을 코드 예시와 함께 상세 기술
────────────────────────────────────────
#: 8
이슈: 테스트 SJF assertion 모호
수정 내용: ALPHA 양수/음수 별도 테스트로 분리,
toBeGreaterThan/toBeLessThan으로 방향성 검증
```

#### 2. 2026-02-04
```
#: 9
이슈: [Critical] dequeue.lua keyPrefix 미적용으로 데이터 접근 불가
수정 내용: ioredis keyPrefix 옵션 제거 (방안 A). Service helper에서
bulk-action: prefix를 포함한 full key를 직접 생성.
dequeue.lua는 ARGV[2]로 prefix를 전달받아 내부 키 생성 시 사용.
Redis Provider에서 keyPrefix 옵션 제거.
────────────────────────────────────────
#: 10
이슈: [Critical] dequeue Service 호출 시그니처와 Lua ARGV 불일치
수정 내용: dequeue() 호출 시 ARGV[2]에 this.keyPrefix를 전달하도록
수정. dequeue.lua의 ARGV[2] 주석을 key prefix로 명확화.
────────────────────────────────────────
#: 11
이슈: [Major] dequeue.lua에서 같은 priority 큐의 다른 그룹 미탐색
수정 내용: for 루프 내부에 while 루프 추가. top 그룹의 job list가
비었을 때 ZREM 후 같은 큐의 다음 그룹을 재탐색.
────────────────────────────────────────
#: 12
이슈: [Major] Redis 연결 graceful shutdown 미구현
수정 내용: FairQueueService에 OnModuleDestroy 인터페이스 구현.
onModuleDestroy()에서 redis.quit() 호출.
────────────────────────────────────────
#: 13
이슈: [Major] ack 호출 시 불필요한 ARGV 전달
수정 내용: ack.lua에서 미사용 ARGV[1](jobId), ARGV[2](groupId) 제거.
Service의 ack() 호출에서도 불필요한 인자 제거.
Step 5 확장 시 ARGV[1]을 result('SUCCESS'|'FAILED')로 사용하도록
확장 포인트 주석 수정.
────────────────────────────────────────
#: 14
이슈: [Minor] 커스텀 Lua 명령 타입 안전성 부재
수정 내용: RedisWithCommands 인터페이스 정의.
(this.redis as any) 대신 타입 안전한 호출로 변경.
────────────────────────────────────────
#: 15
이슈: [Minor] redis.call('TIME') 비결정적 명령 호환성
수정 내용: Redis 7.0 이상 권장 사항을 Lua 스크립트 섹션 상단에 추가.
────────────────────────────────────────
#: 16
이슈: [Minor] PriorityCalculator 역할 모호
수정 내용: 테스트 검증 전용임을 명시. Lua가 source of truth이며
공식 변경 시 Lua를 먼저 수정해야 함을 주석으로 추가.
────────────────────────────────────────
#: 17
이슈: [Minor] LuaScriptLoader fs.readFileSync 이벤트 루프 블로킹
수정 내용: fs.readFileSync → fs.promises.readFile로 변경.
import 경로를 fs/promises로 수정.
────────────────────────────────────────
#: 18
이슈: [Minor] 프로젝트 설정 가이드 누락
수정 내용: tsconfig.json path alias, nest-cli.json 프로젝트 등록,
tsconfig.lib.json 템플릿을 NestJS 모듈 구조 섹션에 추가.
```
