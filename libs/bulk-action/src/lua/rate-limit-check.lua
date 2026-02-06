-- KEYS[1]: per-group rate limit key (e.g., bulk-action:rate-limit:{groupId}:{window})
-- KEYS[2]: global rate limit key (e.g., bulk-action:rate-limit:global:{window})
-- KEYS[3]: active groups set (e.g., bulk-action:active-groups)
-- ARGV[1]: global RPS limit
-- ARGV[2]: groupId
-- ARGV[3]: key TTL (seconds)

-- 1. Register group as active
redis.call('SADD', KEYS[3], ARGV[2])

-- 2. Check global rate limit
local globalCount = redis.call('INCR', KEYS[2])
if globalCount == 1 then
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
end

local globalLimit = tonumber(ARGV[1])
if globalCount > globalLimit then
  redis.call('DECR', KEYS[2])
  return {0, globalCount - 1, globalLimit, 0, 0}
end

-- 3. Check per-group rate limit
local activeGroupCount = redis.call('SCARD', KEYS[3])
local perGroupLimit = math.floor(globalLimit / math.max(1, activeGroupCount))
perGroupLimit = math.max(1, perGroupLimit)

local groupCount = redis.call('INCR', KEYS[1])
if groupCount == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
end

if groupCount > perGroupLimit then
  redis.call('DECR', KEYS[1])
  redis.call('DECR', KEYS[2])
  return {0, globalCount, globalLimit, groupCount - 1, perGroupLimit}
end

-- 4. Allowed
return {1, globalCount, globalLimit, groupCount, perGroupLimit}

--[[
================================================================================
RATE LIMIT CHECK SCRIPT FLOW
================================================================================

[입력]
  KEYS[1]: 그룹별 Rate Limit 키 (bulk-action:rate-limit:{groupId}:{window})
  KEYS[2]: 전역 Rate Limit 키 (bulk-action:rate-limit:global:{window})
  KEYS[3]: 활성 그룹 Set (bulk-action:active-groups)
  ARGV[1]: 전역 RPS 제한값
  ARGV[2]: groupId
  ARGV[3]: 키 TTL (초)

[출력]
  {allowed, globalCount, globalLimit, groupCount, perGroupLimit}
  - allowed: 1=허용, 0=거부

================================================================================
STEP 1: 그룹 활성화 등록
================================================================================
  SADD active-groups groupId
  → 현재 그룹을 활성 그룹 Set에 등록
  → 이후 perGroupLimit 계산에 사용됨

================================================================================
STEP 2: 전역 Rate Limit 검사
================================================================================
  globalCount = INCR global-key
  → 먼저 증가시키고 검사 (optimistic increment)

  if globalCount == 1 then EXPIRE (TTL 설정)
  → 첫 요청일 때만 TTL 설정 (윈도우 만료용)

  if globalCount > globalLimit then
    DECR global-key  ← 롤백
    return {0, ...}  ← 거부
  → 전역 제한 초과 시 증가분 롤백 후 거부

================================================================================
STEP 3: 그룹별 Rate Limit 검사
================================================================================
  activeGroupCount = SCARD active-groups
  → 현재 활성 그룹 수 조회

  perGroupLimit = floor(globalLimit / activeGroupCount)
  perGroupLimit = max(1, perGroupLimit)
  → 전역 제한을 활성 그룹 수로 균등 분배 (최소 1 보장)
  → 예: globalLimit=100, 4개 그룹 → 그룹당 25 RPS

  groupCount = INCR group-key
  if groupCount == 1 then EXPIRE

  if groupCount > perGroupLimit then
    DECR group-key   ← 그룹 카운트 롤백
    DECR global-key  ← 전역 카운트도 롤백 (STEP 2에서 증가했으므로)
    return {0, ...}  ← 거부

================================================================================
STEP 4: 허용
================================================================================
  return {1, globalCount, globalLimit, groupCount, perGroupLimit}
  → 모든 검사 통과, 요청 허용

================================================================================
FLOW DIAGRAM
================================================================================

  checkRateLimit(groupId)
          │
          ▼
  ┌───────────────────┐
  │ SADD active-groups│
  └─────────┬─────────┘
            ▼
  ┌───────────────────┐
  │ INCR global-key   │
  └─────────┬─────────┘
            ▼
       globalCount
       > globalLimit?
          │
    ┌─────┴─────┐
    │YES        │NO
    ▼           ▼
  DECR      ┌───────────────────┐
  return 0  │ INCR group-key    │
            └─────────┬─────────┘
                      ▼
                 groupCount
                 > perGroupLimit?
                    │
              ┌─────┴─────┐
              │YES        │NO
              ▼           ▼
            DECR×2     return 1
            return 0   (허용)
            (거부)

================================================================================
]]
