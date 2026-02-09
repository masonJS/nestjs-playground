-- KEYS[1]: non-ready queue (Sorted Set)
-- KEYS[2]: ready queue (List)
-- ARGV[1]: current time (epoch ms)
-- ARGV[2]: max batch size
-- ARGV[3]: key prefix (optional, for congestion counter decrement)

local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))

if #jobs == 0 then
  return 0
end

local prefix = ARGV[3]

for _, jobId in ipairs(jobs) do
  redis.call('ZREM', KEYS[1], jobId)
  redis.call('RPUSH', KEYS[2], jobId)

  if prefix then
    local jobKey = prefix .. 'job:' .. jobId
    local groupId = redis.call('HGET', jobKey, 'groupId')
    if groupId then
      local countKey = prefix .. 'congestion:' .. groupId .. ':non-ready-count'
      local newCount = redis.call('DECR', countKey)
      if newCount < 0 then
        redis.call('SET', countKey, '0')
      end
      local statsKey = prefix .. 'congestion:' .. groupId .. ':stats'
      redis.call('HSET', statsKey, 'currentNonReadyCount', tostring(math.max(0, newCount)))
    end
  end
end

return #jobs

--[[
================================================================================
MOVE TO READY SCRIPT FLOW
================================================================================

[입력]
  KEYS[1]: Non-Ready Queue (Sorted Set, score = 실행 가능 시각 epoch ms)
  KEYS[2]: Ready Queue (List)
  ARGV[1]: 현재 시각 (epoch ms)
  ARGV[2]: 최대 배치 크기
  ARGV[3]: 키 prefix (optional, congestion 카운터 감소용)

[출력]
  이동된 job 수 (integer)
  - 0: 이동할 job 없음
  - N: N개 job이 non-ready → ready로 이동됨

================================================================================
STEP 1: 이동 대상 job 조회
================================================================================
  ZRANGEBYSCORE non-ready-queue -inf currentTime LIMIT 0 maxBatchSize
  → score(실행 가능 시각) ≤ 현재 시각인 job들을 최대 maxBatchSize개 조회
  → 결과가 0개이면 즉시 return 0

================================================================================
STEP 2: job 이동 (non-ready → ready)
================================================================================
  각 jobId에 대해:
    ZREM non-ready-queue jobId   ← Sorted Set에서 제거
    RPUSH ready-queue jobId      ← List 끝에 추가 (FIFO)

================================================================================
STEP 3: Congestion 카운터 감소 (prefix가 있을 때만)
================================================================================
  각 jobId에 대해:
    HGET {prefix}job:{jobId} groupId
    → job의 groupId 조회

    if groupId exists:
      DECR {prefix}congestion:{groupId}:non-ready-count
      → non-ready 카운터 감소

      if newCount < 0:
        SET countKey '0'         ← 음수 방지 (floor clamp)

      HSET {prefix}congestion:{groupId}:stats currentNonReadyCount max(0, newCount)
      → stats 해시에 현재 non-ready 수 동기화

================================================================================
STEP 4: 결과 반환
================================================================================
  return #jobs
  → 이동된 총 job 수 반환

================================================================================
FLOW DIAGRAM
================================================================================

  moveToReady(currentTime, maxBatchSize, prefix?)
          │
          ▼
  ┌─────────────────────────────┐
  │ ZRANGEBYSCORE non-ready     │
  │ score ≤ currentTime         │
  │ LIMIT maxBatchSize          │
  └─────────────┬───────────────┘
                ▼
           jobs == 0?
              │
        ┌─────┴─────┐
        │YES         │NO
        ▼            ▼
     return 0   ┌────────────────┐
                │ for each job:  │
                │  ZREM + RPUSH  │◄──── non-ready → ready 이동
                └───────┬────────┘
                        ▼
                   prefix 있음?
                      │
                ┌─────┴─────┐
                │NO          │YES
                ▼            ▼
             (skip)   ┌──────────────────┐
                      │ HGET job groupId │
                      └───────┬──────────┘
                              ▼
                        groupId 있음?
                            │
                      ┌─────┴─────┐
                      │NO          │YES
                      ▼            ▼
                   (skip)   ┌──────────────────────┐
                            │ DECR non-ready-count  │
                            │ clamp to 0 if < 0     │
                            │ HSET stats 동기화     │
                            └──────────────────────┘
                                      │
                                      ▼
                               return #jobs

================================================================================
]]
