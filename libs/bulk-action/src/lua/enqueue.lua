local fairQueueKey = KEYS[1]  -- fair-queue sorted set
local groupJobsKey = KEYS[2]  -- group jobs list
local groupMetaKey = KEYS[3]  -- group meta hash
local jobDataKey   = KEYS[4]  -- job data hash

local groupId       = ARGV[1]
local jobId         = ARGV[2]
local payload       = ARGV[3]
local basePriority  = tonumber(ARGV[4])
local priorityLevel = ARGV[5]
local alpha         = tonumber(ARGV[6])
local jobProcessorType = ARGV[7]

local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)

-- 1. 작업 데이터 저장
redis.call('HSET', jobDataKey,
  'id', jobId,
  'groupId', groupId,
  'processorType', jobProcessorType,
  'payload', payload,
  'status', 'PENDING',
  'retryCount', '0',
  'createdAt', tostring(nowMs)
)

-- 2. 그룹 작업 목록에 추가
redis.call('RPUSH', groupJobsKey, jobId)

-- 3. 그룹 메타데이터 업데이트
local totalJobs = redis.call('HINCRBY', groupMetaKey, 'totalJobs', 1)
local doneJobs = tonumber(redis.call('HGET', groupMetaKey, 'doneJobs') or '0')

-- 최초 등록 시 메타데이터 초기화
if totalJobs == 1 then
  redis.call('HSET', groupMetaKey,
    'basePriority', basePriority,
    'priorityLevel', priorityLevel,
    'doneJobs', '0',
    'createdAt', tostring(nowMs),
    'status', 'CREATED'
  )
end

-- 4. 우선순위 계산
local remaining = math.max(1, totalJobs - doneJobs)
local sjfBoost = alpha * (-1 + totalJobs / remaining)
local priority = (-1 * nowMs) + basePriority + sjfBoost

-- 5. Sorted Set에 그룹 등록/갱신
redis.call('ZADD', fairQueueKey, priority, groupId)

return {totalJobs, priority}
