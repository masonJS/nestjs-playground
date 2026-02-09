-- KEYS[1]: non-ready queue (Sorted Set)
-- KEYS[2]: congestion stats Hash
-- KEYS[3]: congestion non-ready count
-- KEYS[4]: active-groups Set
-- ARGV[1]: jobId
-- ARGV[2]: globalRps
-- ARGV[3]: baseBackoffMs
-- ARGV[4]: maxBackoffMs
-- ARGV[5]: currentTimeMs (Date.now())

-- 1. Increment non-ready count for this group
local nonReadyCount = redis.call('INCR', KEYS[3])

-- 2. Get active group count
local activeGroups = redis.call('SCARD', KEYS[4])
if activeGroups < 1 then
  activeGroups = 1
end

-- 3. Calculate rate limit speed per group
local globalRps = tonumber(ARGV[2])
local rateLimitSpeed = math.max(1, math.floor(globalRps / activeGroups))

-- 4. Calculate dynamic backoff
local baseBackoffMs = tonumber(ARGV[3])
local maxBackoffMs = tonumber(ARGV[4])
local currentTimeMs = tonumber(ARGV[5])

local backoffMs = baseBackoffMs + math.floor(nonReadyCount / rateLimitSpeed) * 1000
if backoffMs > maxBackoffMs then
  backoffMs = maxBackoffMs
end

-- 5. Add job to non-ready queue with calculated execute-at time
local executeAt = currentTimeMs + backoffMs
redis.call('ZADD', KEYS[1], executeAt, ARGV[1])

-- 6. Update congestion stats
redis.call('HSET', KEYS[2],
  'currentNonReadyCount', tostring(nonReadyCount),
  'lastBackoffMs', tostring(backoffMs),
  'rateLimitSpeed', tostring(rateLimitSpeed),
  'lastUpdatedMs', tostring(currentTimeMs)
)

return {backoffMs, nonReadyCount, rateLimitSpeed}
