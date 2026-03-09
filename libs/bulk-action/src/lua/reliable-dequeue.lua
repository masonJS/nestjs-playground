local readyQueueKey       = KEYS[1]  -- bulk-action:ready-queue
local inFlightQueueKey    = KEYS[2]  -- bulk-action:in-flight-queue
local inFlightMetaPrefix  = KEYS[3]  -- bulk-action:in-flight:

local ackTimeoutMs = tonumber(ARGV[1])
local workerId     = ARGV[2]
local instanceId   = ARGV[3]
local retryCount   = ARGV[4]
local groupId      = ARGV[5]

-- 1. Ready Queue에서 작업 꺼냄
local jobId = redis.call('LPOP', readyQueueKey)
if not jobId then
  return nil
end

-- 2. deadline 계산 (현재 시각 + ackTimeoutMs)
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local deadline = nowMs + ackTimeoutMs

-- 3. In-flight Queue에 등록 (score = deadline)
redis.call('ZADD', inFlightQueueKey, deadline, jobId)

-- 4. In-flight 메타데이터 저장
local metaKey = inFlightMetaPrefix .. jobId
redis.call('HSET', metaKey,
  'jobId', jobId,
  'workerId', workerId,
  'instanceId', instanceId,
  'deadline', tostring(deadline),
  'dequeuedAt', tostring(nowMs),
  'retryCount', retryCount,
  'groupId', groupId
)

return {jobId, tostring(deadline)}
