local readyQueueKey = KEYS[1]  -- ready queue (List)

local jobId   = ARGV[1]
local maxSize = tonumber(ARGV[2])

local currentSize = redis.call('LLEN', readyQueueKey)
if currentSize >= maxSize then
  return 0
end

redis.call('RPUSH', readyQueueKey, jobId)
return 1
