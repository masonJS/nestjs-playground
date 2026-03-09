local inFlightQueueKey   = KEYS[1]  -- bulk-action:in-flight-queue
local inFlightMetaPrefix = KEYS[2]  -- bulk-action:in-flight:

local jobId      = ARGV[1]
local extensionMs = tonumber(ARGV[2])

-- 1. In-flight Queue에 존재하는지 확인
local currentScore = redis.call('ZSCORE', inFlightQueueKey, jobId)
if not currentScore then
  return 0  -- 이미 제거됨 (ACK 또는 orphan recovery)
end

-- 2. 새 deadline 계산
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local newDeadline = nowMs + extensionMs

-- 3. In-flight Queue 갱신
redis.call('ZADD', inFlightQueueKey, newDeadline, jobId)

-- 4. 메타데이터 갱신
local metaKey = inFlightMetaPrefix .. jobId
redis.call('HSET', metaKey, 'deadline', tostring(newDeadline))

return 1  -- 성공
