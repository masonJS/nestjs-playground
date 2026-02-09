-- KEYS[1]: congestion non-ready count
-- KEYS[2]: congestion stats Hash
-- ARGV[1]: decreaseCount

local decreaseCount = tonumber(ARGV[1])
local newCount = redis.call('DECRBY', KEYS[1], decreaseCount)

if newCount < 0 then
  newCount = 0
  redis.call('SET', KEYS[1], '0')
end

redis.call('HSET', KEYS[2], 'currentNonReadyCount', tostring(newCount))

return newCount
