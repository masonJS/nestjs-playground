local lockKey = KEYS[1]   -- lock key
local token   = ARGV[1]  -- owner token

-- 1. Check ownership
local currentToken = redis.call('GET', lockKey)
if currentToken ~= token then
  return 0  -- not owner or already expired
end

-- 2. Delete
redis.call('DEL', lockKey)

return 1  -- released
