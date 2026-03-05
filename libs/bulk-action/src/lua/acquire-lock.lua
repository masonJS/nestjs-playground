local lockKey = KEYS[1]   -- lock key
local token   = ARGV[1]  -- unique owner token
local ttlMs   = ARGV[2]  -- TTL in milliseconds

-- SET NX PX: set only if not exists, with millisecond expiry
local result = redis.call('SET', lockKey, token, 'NX', 'PX', ttlMs)

if result then
  return 1  -- acquired
end

return 0  -- already held
