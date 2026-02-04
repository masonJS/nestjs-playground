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

local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)

-- 1. 작업 데이터 저장
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
