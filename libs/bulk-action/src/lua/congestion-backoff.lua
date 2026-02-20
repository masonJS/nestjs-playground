local nonReadyQueueKey   = KEYS[1]  -- non-ready queue (Sorted Set)
local congestionStatsKey = KEYS[2]  -- congestion stats Hash
local nonReadyCountKey   = KEYS[3]  -- congestion non-ready count
local activeGroupsKey    = KEYS[4]  -- active-groups Set

local jobId         = ARGV[1]
local globalRps     = tonumber(ARGV[2])
local baseBackoffMs = tonumber(ARGV[3])
local maxBackoffMs  = tonumber(ARGV[4])
local currentTimeMs = tonumber(ARGV[5])

-- 1. Increment non-ready count for this group
local nonReadyCount = redis.call('INCR', nonReadyCountKey)

-- 2. Get active group count
local activeGroups = redis.call('SCARD', activeGroupsKey)
if activeGroups < 1 then
  activeGroups = 1
end

-- 3. Calculate rate limit speed per group
local rateLimitSpeed = math.max(1, math.floor(globalRps / activeGroups))

-- 4. Calculate dynamic backoff
local backoffMs = baseBackoffMs + math.floor(nonReadyCount / rateLimitSpeed) * 1000
if backoffMs > maxBackoffMs then
  backoffMs = maxBackoffMs
end

-- 5. Add job to non-ready queue with calculated execute-at time
local executeAt = currentTimeMs + backoffMs
redis.call('ZADD', nonReadyQueueKey, executeAt, jobId)

-- 6. Update congestion stats
redis.call('HSET', congestionStatsKey,
  'currentNonReadyCount', tostring(nonReadyCount),
  'lastBackoffMs', tostring(backoffMs),
  'rateLimitSpeed', tostring(rateLimitSpeed),
  'lastUpdatedMs', tostring(currentTimeMs)
)

return {backoffMs, nonReadyCount, rateLimitSpeed}
