local inFlightQueueKey   = KEYS[1]  -- bulk-action:in-flight-queue
local readyQueueKey      = KEYS[2]  -- bulk-action:ready-queue
local deadLetterQueueKey = KEYS[3]  -- bulk-action:dead-letter-queue
local inFlightMetaPrefix = KEYS[4]  -- bulk-action:in-flight:

local nowMs          = tonumber(ARGV[1])
local batchSize      = tonumber(ARGV[2])
local maxRetryCount  = tonumber(ARGV[3])
local jobKeyPrefix   = ARGV[4]  -- e.g. 'test:job:'

-- 1. deadline이 지난 작업 조회
local orphans = redis.call('ZRANGEBYSCORE', inFlightQueueKey, '-inf', nowMs, 'LIMIT', 0, batchSize)

if #orphans == 0 then
  return {0, 0}
end

local recovered = 0
local deadLettered = 0
local deadLetteredPairs = {}  -- {jobId1, groupId1, jobId2, groupId2, ...}

for _, jobId in ipairs(orphans) do
  -- In-flight Queue에서 제거
  redis.call('ZREM', inFlightQueueKey, jobId)

  -- 메타데이터에서 retryCount, groupId 조회
  local metaKey = inFlightMetaPrefix .. jobId
  local meta = redis.call('HGETALL', metaKey)

  local retryCount = 0
  local groupId = ''

  -- 메타데이터 파싱
  if #meta > 0 then
    for i = 1, #meta, 2 do
      if meta[i] == 'retryCount' then
        retryCount = tonumber(meta[i + 1]) or 0
      elseif meta[i] == 'groupId' then
        groupId = meta[i + 1]
      end
    end
  else
    -- 메타데이터가 없으면 Job Hash에서 fallback 조회
    local jobKey = jobKeyPrefix .. jobId
    retryCount = tonumber(redis.call('HGET', jobKey, 'retryCount') or '0')
    groupId = redis.call('HGET', jobKey, 'groupId') or ''
  end

  -- 메타데이터 삭제
  redis.call('DEL', metaKey)

  if retryCount >= maxRetryCount then
    -- DLQ로 이동
    local entry = cjson.encode({
      jobId = jobId,
      groupId = groupId,
      retryCount = retryCount,
      error = 'orphan: max retries exceeded',
      failedAt = nowMs,
    })
    redis.call('RPUSH', deadLetterQueueKey, entry)

    -- Job 상태를 FAILED로 변경
    local jobKey = jobKeyPrefix .. jobId
    redis.call('HSET', jobKey, 'status', 'FAILED')

    deadLettered = deadLettered + 1
    table.insert(deadLetteredPairs, jobId)
    table.insert(deadLetteredPairs, groupId)
  else
    -- Ready Queue로 복구, retryCount 증가
    local jobKey = jobKeyPrefix .. jobId
    redis.call('HINCRBY', jobKey, 'retryCount', 1)
    redis.call('HSET', jobKey, 'status', 'PENDING')
    redis.call('RPUSH', readyQueueKey, jobId)

    recovered = recovered + 1
  end
end

-- 반환: [recovered, deadLettered, jobId1, groupId1, jobId2, groupId2, ...]
local result = {recovered, deadLettered}
for _, v in ipairs(deadLetteredPairs) do
  table.insert(result, v)
end

return result
