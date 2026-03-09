local inFlightQueueKey   = KEYS[1]  -- bulk-action:in-flight-queue
local inFlightMetaPrefix = KEYS[2]  -- bulk-action:in-flight:

local jobId = ARGV[1]

-- 1. In-flight Queue에서 제거
local removed = redis.call('ZREM', inFlightQueueKey, jobId)

-- 2. 메타데이터 삭제
local metaKey = inFlightMetaPrefix .. jobId
redis.call('DEL', metaKey)

-- removed=1이면 정상 ACK, 0이면 late ACK (이미 orphan recovery에 의해 제거됨)
return removed
