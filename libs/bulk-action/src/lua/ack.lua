local jobDataKey   = KEYS[1]  -- bulk-action:job:{jobId}
local groupMetaKey = KEYS[2]  -- bulk-action:group:{groupId}:meta

-- 1. 작업 상태를 COMPLETED로 변경
redis.call('HSET', jobDataKey, 'status', 'COMPLETED')

-- 2. 그룹의 doneJobs 증가
local doneJobs = redis.call('HINCRBY', groupMetaKey, 'doneJobs', 1)
local totalJobs = tonumber(redis.call('HGET', groupMetaKey, 'totalJobs') or '0')

-- 3. 모든 작업 완료 여부 반환
if doneJobs >= totalJobs then
  redis.call('HSET', groupMetaKey, 'status', 'AGGREGATING')
  return 1  -- 그룹 완료
end

return 0  -- 아직 진행 중
