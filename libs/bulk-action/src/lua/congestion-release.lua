local nonReadyCountKey   = KEYS[1]  -- congestion non-ready count
local congestionStatsKey = KEYS[2]  -- congestion stats Hash

local decreaseCount = tonumber(ARGV[1])

local newCount = redis.call('DECRBY', nonReadyCountKey, decreaseCount)

if newCount < 0 then
  newCount = 0
  redis.call('SET', nonReadyCountKey, '0')
end

redis.call('HSET', congestionStatsKey, 'currentNonReadyCount', tostring(newCount))

return newCount
