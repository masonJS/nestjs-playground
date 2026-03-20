import { setTimeout } from 'timers/promises';
import { Mock, Mocked } from 'vitest';
import { Worker } from '@app/bulk-action/worker-pool/Worker';
import { WorkerState } from '@app/bulk-action/model/WorkerState';
import { JobProcessor } from '@app/bulk-action/model/job-processor/JobProcessor';
import { JobProcessorResponse } from '@app/bulk-action/model/job-processor/dto/JobProcessorResponse';
import { DequeueResult } from '@app/bulk-action/reliable-queue/DequeueResult';

async function sleep(ms: number): Promise<void> {
  await setTimeout(ms);
}

describe('Worker', () => {
  let worker: Worker;
  let mockProcessor: Mocked<JobProcessor>;
  let onJobComplete: Mock;
  let onJobFailed: Mock;
  let loadJobData: Mock;
  let mockReliableDequeue: Mock;
  let mockReliableAck: Mock;
  let mockReliableNack: Mock;
  let mockExtendDeadline: Mock;

  beforeEach(() => {
    mockProcessor = {
      type: 'TEST',
      process: vi.fn(),
    };

    onJobComplete = vi.fn().mockResolvedValue(undefined);
    onJobFailed = vi.fn().mockResolvedValue(undefined);
    loadJobData = vi.fn().mockResolvedValue({
      id: 'job-001',
      groupId: 'customer-A',
      processorType: 'TEST',
      payload: '{}',
      status: 'PROCESSING',
      retryCount: '0',
      createdAt: '0',
    });

    mockReliableDequeue = vi.fn().mockResolvedValue(null);
    mockReliableAck = vi.fn().mockResolvedValue(true);
    mockReliableNack = vi.fn().mockResolvedValue(undefined);
    mockExtendDeadline = vi.fn().mockResolvedValue(true);

    const processorMap = new Map([['TEST', mockProcessor]]);

    worker = new Worker(0, processorMap, {
      jobTimeoutMs: 5000,
      pollIntervalMs: 50,
      onJobComplete,
      onJobFailed,
      loadJobData,
      reliableDequeue: mockReliableDequeue,
      reliableAck: mockReliableAck,
      reliableNack: mockReliableNack,
      extendDeadline: mockExtendDeadline,
    });
  });

  afterEach(async () => {
    await worker.stop();
  });

  function makeDequeueResult(jobId: string): DequeueResult {
    return { jobId, deadline: Date.now() + 5000 };
  }

  it('Reliable dequeue로 작업을 꺼내 프로세서로 실행한다', async () => {
    // given
    mockReliableDequeue
      .mockResolvedValueOnce(makeDequeueResult('job-001'))
      .mockResolvedValue(null);

    mockProcessor.process.mockResolvedValue({
      jobId: 'job-001',
      groupId: 'customer-A',
      success: true,
      durationMs: 50,
    });

    // when
    worker.start();
    await sleep(300);

    // then
    expect(mockProcessor.process).toHaveBeenCalledTimes(1);
    expect(mockReliableAck).toHaveBeenCalledWith('job-001');
    expect(onJobComplete).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-001', success: true }),
    );
  });

  it('성공 시 reliableAck이 호출된다', async () => {
    // given
    mockReliableDequeue
      .mockResolvedValueOnce(makeDequeueResult('job-001'))
      .mockResolvedValue(null);

    mockProcessor.process.mockResolvedValue({
      jobId: 'job-001',
      groupId: 'customer-A',
      success: true,
      durationMs: 50,
    });

    // when
    worker.start();
    await sleep(300);

    // then
    expect(mockReliableAck).toHaveBeenCalledWith('job-001');
    expect(mockReliableNack).not.toHaveBeenCalled();
  });

  it('프로세서 예외 시 reliableNack과 onJobFailed가 호출된다', async () => {
    // given
    mockReliableDequeue
      .mockResolvedValueOnce(makeDequeueResult('job-001'))
      .mockResolvedValue(null);

    mockProcessor.process.mockRejectedValue(new Error('API timeout'));

    // when
    worker.start();
    await sleep(300);

    // then
    expect(mockReliableNack).toHaveBeenCalledWith('job-001');
    expect(onJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-001' }),
      expect.any(Error),
    );
  });

  it('retryable=true인 실패 결과는 reliableNack + onJobFailed를 호출한다', async () => {
    // given
    mockReliableDequeue
      .mockResolvedValueOnce(makeDequeueResult('job-001'))
      .mockResolvedValue(null);

    mockProcessor.process.mockResolvedValue({
      jobId: 'job-001',
      groupId: 'customer-A',
      success: false,
      error: { message: 'Temporary failure', retryable: true },
      durationMs: 10,
    });

    // when
    worker.start();
    await sleep(300);

    // then
    expect(mockReliableNack).toHaveBeenCalledWith('job-001');
    expect(onJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-001' }),
      expect.any(Error),
    );
    expect(onJobComplete).not.toHaveBeenCalled();
  });

  it('retryable=false인 실패 결과는 reliableAck + onJobComplete를 호출한다', async () => {
    // given
    mockReliableDequeue
      .mockResolvedValueOnce(makeDequeueResult('job-001'))
      .mockResolvedValue(null);

    mockProcessor.process.mockResolvedValue({
      jobId: 'job-001',
      groupId: 'customer-A',
      success: false,
      error: { message: 'Permanent failure', retryable: false },
      durationMs: 10,
    });

    // when
    worker.start();
    await sleep(300);

    // then
    expect(mockReliableAck).toHaveBeenCalledWith('job-001');
    expect(onJobComplete).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-001', success: false }),
    );
    expect(onJobFailed).not.toHaveBeenCalled();
  });

  it('loadJobData가 null이면 reliableAck(cleanup)을 호출한다', async () => {
    // given
    loadJobData.mockResolvedValue(null);

    mockReliableDequeue
      .mockResolvedValueOnce(makeDequeueResult('job-missing'))
      .mockResolvedValue(null);

    // when
    worker.start();
    await sleep(300);

    // then
    expect(mockReliableAck).toHaveBeenCalledWith('job-missing');
    expect(mockProcessor.process).not.toHaveBeenCalled();
    expect(onJobComplete).not.toHaveBeenCalled();
    expect(onJobFailed).not.toHaveBeenCalled();
  });

  it('작업이 jobTimeoutMs를 초과하면 타임아웃 + reliableNack 호출', async () => {
    // given
    worker = new Worker(0, new Map([['TEST', mockProcessor]]), {
      jobTimeoutMs: 500,
      pollIntervalMs: 50,
      onJobComplete,
      onJobFailed,
      loadJobData,
      reliableDequeue: mockReliableDequeue,
      reliableAck: mockReliableAck,
      reliableNack: mockReliableNack,
      extendDeadline: mockExtendDeadline,
    });

    mockReliableDequeue
      .mockResolvedValueOnce(makeDequeueResult('job-001'))
      .mockResolvedValue(null);

    mockProcessor.process.mockImplementation(async () => setTimeout(5000));

    // when
    worker.start();
    await sleep(1000);

    // then
    expect(mockReliableNack).toHaveBeenCalledWith('job-001');
    expect(onJobFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: expect.stringContaining('timed out'),
      }),
    );
  }, 5000);

  it('stop() 호출 시 현재 작업 완료 후 종료한다', async () => {
    // given
    let resolveProcess!: (value: JobProcessorResponse) => void;
    mockReliableDequeue
      .mockResolvedValueOnce(makeDequeueResult('job-001'))
      .mockResolvedValue(null);

    mockProcessor.process.mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolveProcess = resolve;
        }),
    );

    // when
    worker.start();
    await sleep(100);

    expect(worker.getState()).toBe(WorkerState.RUNNING);

    const stopPromise = worker.stop();

    // then - Worker는 STOPPING 상태
    expect(worker.getState()).toBe(WorkerState.STOPPING);

    // 작업 완료
    resolveProcess({
      jobId: 'job-001',
      groupId: 'customer-A',
      success: true,
      durationMs: 0,
    });

    await stopPromise;
    expect(worker.getState()).toBe(WorkerState.STOPPED);
  });

  it('dequeue가 null이면 pollIntervalMs 대기 후 재시도한다', async () => {
    // given
    mockReliableDequeue.mockResolvedValue(null);

    // when
    worker.start();
    await sleep(300);

    // then
    expect(mockReliableDequeue).toHaveBeenCalled();
    expect(mockProcessor.process).not.toHaveBeenCalled();
  });

  it('등록되지 않은 job type이면 reliableNack + onJobFailed가 호출된다', async () => {
    // given
    loadJobData.mockResolvedValue({
      id: 'job-001',
      groupId: 'customer-A',
      processorType: 'UNKNOWN_TYPE',
      payload: '{}',
      status: 'PROCESSING',
      retryCount: '0',
      createdAt: '0',
    });

    mockReliableDequeue
      .mockResolvedValueOnce(makeDequeueResult('job-001'))
      .mockResolvedValue(null);

    // when
    worker.start();
    await sleep(300);

    // then
    expect(mockReliableNack).toHaveBeenCalledWith('job-001');
    expect(onJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-001' }),
      expect.objectContaining({
        message: expect.stringContaining('No processor registered'),
      }),
    );
  });

  it('IDLE 상태가 아니면 start()를 무시한다', () => {
    // given
    mockReliableDequeue.mockResolvedValue(null);

    worker.start();

    // when
    worker.start();

    // then
    expect(worker.getState()).toBe(WorkerState.RUNNING);
  });

  it('heartbeat으로 extendDeadline이 호출된다', async () => {
    // given — jobTimeoutMs=300, heartbeat 간격은 180ms (60%)
    worker = new Worker(0, new Map([['TEST', mockProcessor]]), {
      jobTimeoutMs: 300,
      pollIntervalMs: 50,
      onJobComplete,
      onJobFailed,
      loadJobData,
      reliableDequeue: mockReliableDequeue,
      reliableAck: mockReliableAck,
      reliableNack: mockReliableNack,
      extendDeadline: mockExtendDeadline,
    });

    mockReliableDequeue
      .mockResolvedValueOnce(makeDequeueResult('job-001'))
      .mockResolvedValue(null);

    // 프로세서가 400ms 소요 → heartbeat이 최소 1번 발생
    mockProcessor.process.mockImplementation(async () => {
      await setTimeout(400);

      return {
        jobId: 'job-001',
        groupId: 'customer-A',
        success: true,
        durationMs: 400,
      };
    });

    // when
    worker.start();
    await sleep(800);

    // then
    expect(mockExtendDeadline).toHaveBeenCalledWith('job-001');
  }, 5000);
});
