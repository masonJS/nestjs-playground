-- KEYS[1]: non-ready queue (Sorted Set)
-- KEYS[2]: ready queue (List)
-- ARGV[1]: current time (epoch ms)
-- ARGV[2]: max batch size

local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))

if #jobs == 0 then
  return 0
end

for _, jobId in ipairs(jobs) do
  redis.call('ZREM', KEYS[1], jobId)
  redis.call('RPUSH', KEYS[2], jobId)
end

return #jobs