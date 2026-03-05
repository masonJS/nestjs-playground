local groupMetaKey = KEYS[1]  -- bulk-action:group:{groupId}:meta
local resultListKey = KEYS[2] -- bulk-action:group:{groupId}:job-results

local resultType = ARGV[1]   -- "success" | "failed"
local resultJson = ARGV[2]   -- result JSON
local nowMs      = ARGV[3]   -- current timestamp ms

-- 1. successCount / failedCount HINCRBY
if resultType == 'success' then
  redis.call('HINCRBY', groupMetaKey, 'successCount', 1)
else
  redis.call('HINCRBY', groupMetaKey, 'failedCount', 1)
end

-- 2. RPUSH result JSON to job-results list
redis.call('RPUSH', resultListKey, resultJson)

-- 3. Record first job started time (only once)
redis.call('HSETNX', groupMetaKey, 'firstJobStartedAt', nowMs)

-- 4. Update lastUpdatedAt
redis.call('HSET', groupMetaKey, 'lastUpdatedAt', nowMs)

-- 5. Read counters for return
local successCount = tonumber(redis.call('HGET', groupMetaKey, 'successCount') or '0')
local failedCount = tonumber(redis.call('HGET', groupMetaKey, 'failedCount') or '0')
local totalJobs = tonumber(redis.call('HGET', groupMetaKey, 'totalJobs') or '0')

-- 6. Check if all jobs are counted
local isComplete = 0
if (successCount + failedCount) >= totalJobs and totalJobs > 0 then
  isComplete = 1
end

return { isComplete, successCount, failedCount, totalJobs }
