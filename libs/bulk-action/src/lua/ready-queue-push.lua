-- KEYS[1]: ready queue (List)
-- ARGV[1]: jobId
-- ARGV[2]: maxSize

local currentSize = redis.call('LLEN', KEYS[1])
if currentSize >= tonumber(ARGV[2]) then
  return 0
end

redis.call('RPUSH', KEYS[1], ARGV[1])
return 1