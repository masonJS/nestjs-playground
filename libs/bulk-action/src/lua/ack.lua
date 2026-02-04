-- KEYS[1]: job data hash (e.g., bulk-action:job:{jobId})
-- KEYS[2]: group meta hash (e.g., bulk-action:group:{groupId}:meta)

-- 1. 작업 상태를 COMPLETED로 변경
redis.call('HSET', KEYS[1], 'status', 'COMPLETED')

-- 2. 그룹의 doneJobs 증가
local doneJobs = redis.call('HINCRBY', KEYS[2], 'doneJobs', 1)
local totalJobs = tonumber(redis.call('HGET', KEYS[2], 'totalJobs') or '0')

-- 3. 모든 작업 완료 여부 반환
if doneJobs >= totalJobs then
  redis.call('HSET', KEYS[2], 'status', 'AGGREGATING')
  return 1  -- 그룹 완료
end

return 0  -- 아직 진행 중
