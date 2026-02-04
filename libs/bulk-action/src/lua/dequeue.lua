-- KEYS[1]: high priority queue (e.g., bulk-action:fair-queue:high)
-- KEYS[2]: normal priority queue (e.g., bulk-action:fair-queue:normal)
-- KEYS[3]: low priority queue (e.g., bulk-action:fair-queue:low)
-- ARGV[1]: ALPHA
-- ARGV[2]: key prefix (e.g., 'bulk-action:')

local prefix = ARGV[2]

-- 우선순위 순서대로 큐 탐색
local queues = {KEYS[1], KEYS[2], KEYS[3]}

for _, queueKey in ipairs(queues) do
  -- 같은 큐 내에서 유효한 그룹을 찾을 때까지 반복
  while true do
    -- 1. 가장 높은 우선순위 그룹 조회 (score가 가장 작은 것)
    local result = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')

    if #result == 0 then
      break  -- 이 큐에 그룹이 없음, 다음 priority 큐로
    end

    local groupId = result[1]
    local groupJobsKey = prefix .. 'group:' .. groupId .. ':jobs'
    local groupMetaKey = prefix .. 'group:' .. groupId .. ':meta'

    -- 2. 그룹의 작업 목록에서 하나 꺼냄
    local jobId = redis.call('LPOP', groupJobsKey)

    if jobId then
      local jobKey = prefix .. 'job:' .. jobId

      -- 3. 작업 상태를 PROCESSING으로 변경
      redis.call('HSET', jobKey, 'status', 'PROCESSING')

      -- 4. 그룹 메타데이터에서 우선순위 재계산
      local totalJobs = tonumber(redis.call('HGET', groupMetaKey, 'totalJobs') or '0')
      local doneJobs = tonumber(redis.call('HGET', groupMetaKey, 'doneJobs') or '0')
      local remainingJobs = redis.call('LLEN', groupJobsKey)

      if remainingJobs == 0 then
        -- 남은 작업이 없으면 큐에서 그룹 제거
        redis.call('ZREM', queueKey, groupId)
      else
        -- 우선순위 재계산 후 갱신
        local now = redis.call('TIME')
        local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
        local basePriority = tonumber(redis.call('HGET', groupMetaKey, 'basePriority') or '0')
        local alpha = tonumber(ARGV[1])
        local remaining = math.max(1, totalJobs - doneJobs)
        local sjfBoost = alpha * (-1 + totalJobs / remaining)
        local newPriority = (-1 * nowMs) + basePriority + sjfBoost
        redis.call('ZADD', queueKey, newPriority, groupId)
      end

      -- 5. 작업 데이터 반환
      local jobData = redis.call('HGETALL', jobKey)
      return jobData
    else
      -- 작업 목록이 비었으면 큐에서 제거하고, 같은 큐의 다음 그룹 탐색
      redis.call('ZREM', queueKey, groupId)
      -- while 루프가 계속되어 같은 큐의 다음 그룹을 시도
    end
  end
end

return nil
