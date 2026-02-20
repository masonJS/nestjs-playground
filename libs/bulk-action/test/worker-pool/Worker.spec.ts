import { setTimeout } from 'timers/promises';
import { Worker } from '@app/bulk-action/worker-pool/Worker';
import { WorkerState } from '@app/bulk-action/model/WorkerState';
import { JobProcessor } from '@app/bulk-action/model/job-processor/JobProcessor';
import { ReadyQueueService } from '@app/bulk-action/backpressure/ReadyQueueService';
import { JobProcessorResponse } from '@app/bulk-action/model/job-processor/dto/JobProcessorResponse';

async function sleep(ms: number): Promise<void> {
  await setTimeout(ms);
}

/**
 * 실제 BLPOP처럼 지연 후 null을 반환하는 mock.
 * 즉시 null을 반환하면 Worker 루프가 tight spin → OOM 발생.
 */
function blockingNull(delayMs = 100): () => Promise<string | null> {
  return async () => {
    await setTimeout(delayMs);

    return null;
  };
}

describe('Worker', () => {
  let worker: Worker;
  let mockReadyQueue: jest.Mocked<ReadyQueueService>;
  let mockProcessor: jest.Mocked<JobProcessor>;
  let onJobComplete: jest.Mock;
  let onJobFailed: jest.Mock;
  let loadJobData: jest.Mock;

  beforeEach(() => {
    mockReadyQueue = {
      blockingPop: jest.fn(),
    } as any;

    mockProcessor = {
      type: 'TEST',
      process: jest.fn(),
    };

    onJobComplete = jest.fn().mockResolvedValue(undefined);
    onJobFailed = jest.fn().mockResolvedValue(undefined);
    loadJobData = jest.fn().mockResolvedValue({
      id: 'job-001',
      groupId: 'customer-A',
      processorType: 'TEST',
      payload: '{}',
      status: 'PROCESSING',
      retryCount: '0',
      createdAt: '0',
    });

    const processorMap = new Map([['TEST', mockProcessor]]);

    worker = new Worker(0, mockReadyQueue, processorMap, {
      timeoutSec: 1,
      jobTimeoutMs: 5000,
      onJobComplete,
      onJobFailed,
      loadJobData,
    });
  });

  afterEach(async () => {
    await worker.stop();
  });

  it('Ready Queue에서 작업을 꺼내 프로세서로 실행한다', async () => {
    // given
    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-001')
      .mockImplementation(blockingNull());

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
    expect(onJobComplete).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-001', success: true }),
    );
  });

  it('프로세서가 실패하면 onJobFailed 콜백을 호출한다', async () => {
    // given
    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-001')
      .mockImplementation(blockingNull());

    mockProcessor.process.mockRejectedValue(new Error('API timeout'));

    // when
    worker.start();
    await sleep(300);

    // then
    expect(onJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-001' }),
      expect.any(Error),
    );
  });

  it('작업이 jobTimeoutMs를 초과하면 타임아웃 오류를 발생시킨다', async () => {
    // given
    worker = new Worker(0, mockReadyQueue, new Map([['TEST', mockProcessor]]), {
      timeoutSec: 1,
      jobTimeoutMs: 500,
      onJobComplete,
      onJobFailed,
      loadJobData,
    });

    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-001')
      .mockImplementation(blockingNull());

    mockProcessor.process.mockImplementation(async () => setTimeout(5000));

    // when
    worker.start();
    await sleep(1000);

    // then
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
    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-001')
      .mockImplementation(blockingNull());

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

  it('Ready Queue가 비어있으면 대기 후 재시도한다', async () => {
    // given
    mockReadyQueue.blockingPop.mockImplementation(blockingNull());

    // when
    worker.start();
    await sleep(300);

    // then
    expect(mockReadyQueue.blockingPop).toHaveBeenCalled();
    expect(mockProcessor.process).not.toHaveBeenCalled();
  });

  it('등록되지 않은 job type이면 onJobFailed가 호출된다', async () => {
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

    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-001')
      .mockImplementation(blockingNull());

    // when
    worker.start();
    await sleep(300);

    // then
    expect(onJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-001' }),
      expect.objectContaining({
        message: expect.stringContaining('No processor registered'),
      }),
    );
  });

  it('loadJobData가 null을 반환하면 작업을 건너뛴다', async () => {
    // given
    loadJobData.mockResolvedValue(null);

    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-missing')
      .mockImplementation(blockingNull());

    // when
    worker.start();
    await sleep(300);

    // then
    expect(mockProcessor.process).not.toHaveBeenCalled();
    expect(onJobComplete).not.toHaveBeenCalled();
    expect(onJobFailed).not.toHaveBeenCalled();
  });

  it('retryable=false인 실패 결과는 onJobComplete로 처리된다', async () => {
    // given
    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-001')
      .mockImplementation(blockingNull());

    mockProcessor.process.mockResolvedValue({
      jobId: 'job-001',
      groupId: 'customer-A',
      success: false,
      error: {
        message: 'Permanent failure',
        retryable: false,
      },
      durationMs: 10,
    });

    // when
    worker.start();
    await sleep(300);

    // then
    expect(onJobComplete).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-001', success: false }),
    );
    expect(onJobFailed).not.toHaveBeenCalled();
  });

  it('retryable=true인 실패 결과는 onJobFailed로 처리된다', async () => {
    // given
    mockReadyQueue.blockingPop
      .mockResolvedValueOnce('job-001')
      .mockImplementation(blockingNull());

    mockProcessor.process.mockResolvedValue({
      jobId: 'job-001',
      groupId: 'customer-A',
      success: false,
      error: {
        message: 'Temporary failure',
        retryable: true,
      },
      durationMs: 10,
    });

    // when
    worker.start();
    await sleep(300);

    // then
    expect(onJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-001' }),
      expect.any(Error),
    );
    expect(onJobComplete).not.toHaveBeenCalled();
  });

  it('IDLE 상태가 아니면 start()를 무시한다', () => {
    // given
    mockReadyQueue.blockingPop.mockImplementation(blockingNull());

    worker.start();

    // when
    worker.start();

    // then
    expect(worker.getState()).toBe(WorkerState.RUNNING);
  });
});
