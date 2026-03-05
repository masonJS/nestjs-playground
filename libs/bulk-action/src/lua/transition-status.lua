local groupMetaKey = KEYS[1]  -- bulk-action:group:{groupId}:meta

local fromStatus = ARGV[1]   -- expected current status
local toStatus   = ARGV[2]   -- target status
local nowMs      = ARGV[3]   -- current timestamp ms

-- 1. Optimistic lock: check current status
local currentStatus = redis.call('HGET', groupMetaKey, 'status')
if currentStatus ~= fromStatus then
  return 0  -- rejected: status mismatch
end

-- 2. Transition
redis.call('HSET', groupMetaKey, 'status', toStatus)
redis.call('HSET', groupMetaKey, 'lastUpdatedAt', nowMs)

-- 3. Record timestamps for specific transitions
if toStatus == 'AGGREGATING' then
  redis.call('HSET', groupMetaKey, 'aggregationStartAt', nowMs)
elseif toStatus == 'COMPLETED' then
  redis.call('HSET', groupMetaKey, 'completedAt', nowMs)
elseif toStatus == 'FAILED' then
  redis.call('HSET', groupMetaKey, 'failedAt', nowMs)
end

return 1  -- success
