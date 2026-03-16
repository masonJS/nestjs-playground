import { setTimeout } from 'timers/promises';
import { DataSource } from 'typeorm';

const sleep = async (ms: number) => setTimeout(ms);

const ROW_COUNT = 100;

function buildInsertSql(count: number): string {
  const values = Array.from({ length: count }, (_, i) => `(${i + 1}, 0)`).join(
    ', ',
  );

  return `INSERT INTO deadlock_test (id, value) VALUES ${values}`;
}

describe('Deadlock Victim Selection', () => {
  describe('PostgreSQL', () => {
    let dsA: DataSource;
    let dsB: DataSource;

    beforeAll(async () => {
      dsA = new DataSource({
        type: 'postgres',
        host: 'localhost',
        port: 5434,
        username: 'test',
        password: 'test',
        database: 'test',
      });
      dsB = new DataSource({
        type: 'postgres',
        host: 'localhost',
        port: 5434,
        username: 'test',
        password: 'test',
        database: 'test',
      });

      await dsA.initialize();
      await dsB.initialize();

      await dsA.query('DROP TABLE IF EXISTS deadlock_test');
      await dsA.query(
        'CREATE TABLE deadlock_test (id INT PRIMARY KEY, value INT DEFAULT 0)',
      );
      await dsA.query(buildInsertSql(ROW_COUNT));
    });

    afterAll(async () => {
      await dsA.query('DROP TABLE IF EXISTS deadlock_test');
      await dsA.destroy();
      await dsB.destroy();
    });

    it('deadlock_timeout 후 감지를 트리거한 트랜잭션(A)이 victim이 된다', async () => {
      // given - 두 개의 독립된 커넥션에서 트랜잭션 시작
      const qrA = dsA.createQueryRunner();
      const qrB = dsB.createQueryRunner();

      try {
        await qrA.query("SET deadlock_timeout = '500ms'");
        await qrB.query("SET deadlock_timeout = '500ms'");

        await qrA.startTransaction();
        await qrB.startTransaction();

        // A: row 1 lock 획득, B: row 2 lock 획득
        await qrA.query('SELECT * FROM deadlock_test WHERE id = 1 FOR UPDATE');
        await qrB.query('SELECT * FROM deadlock_test WHERE id = 2 FOR UPDATE');

        // A: 대량 UPDATE로 무거운 트랜잭션 생성
        await qrA.query(
          `UPDATE deadlock_test SET value = value + 1 WHERE id BETWEEN 3 AND ${ROW_COUNT}`,
        );

        // when - A가 먼저 row 2 lock 요청 (대기 시작, deadlock_timeout 타이머 시작)
        const promiseA = qrA
          .query('SELECT * FROM deadlock_test WHERE id = 2 FOR UPDATE')
          .then(() => ({ status: 'survived' as const }))
          .catch((e: Error) => ({
            status: 'victim' as const,
            error: e.message,
          }));

        // A가 대기 상태에 진입할 시간 확보
        await sleep(100);

        // B가 row 1 lock 요청 → deadlock cycle 형성
        const promiseB = qrB
          .query('SELECT * FROM deadlock_test WHERE id = 1 FOR UPDATE')
          .then(() => ({ status: 'survived' as const }))
          .catch((e: Error) => ({
            status: 'victim' as const,
            error: e.message,
          }));

        const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

        // then - A가 먼저 대기 시작 → deadlock_timeout을 먼저 트리거 → A가 victim
        expect(resultA.status).toBe('victim');
        expect(resultB.status).toBe('survived');

        if (resultA.status === 'victim') {
          expect(resultA.error).toContain('deadlock detected');
        }
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        await qrA.rollbackTransaction().catch(() => {});
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        await qrB.rollbackTransaction().catch(() => {});
        await qrA.release();
        await qrB.release();
      }
    }, 10_000);
  });

  describe('MySQL (InnoDB)', () => {
    let dsA: DataSource;
    let dsB: DataSource;

    beforeAll(async () => {
      dsA = new DataSource({
        type: 'mysql',
        host: 'localhost',
        port: 3307,
        username: 'test',
        password: 'test',
        database: 'test',
      });
      dsB = new DataSource({
        type: 'mysql',
        host: 'localhost',
        port: 3307,
        username: 'test',
        password: 'test',
        database: 'test',
      });

      await dsA.initialize();
      await dsB.initialize();

      await dsA.query('DROP TABLE IF EXISTS deadlock_test');
      await dsA.query(
        'CREATE TABLE deadlock_test (id INT PRIMARY KEY, value INT DEFAULT 0) ENGINE=InnoDB',
      );
      await dsA.query(buildInsertSql(ROW_COUNT));
    });

    afterAll(async () => {
      await dsA.query('DROP TABLE IF EXISTS deadlock_test');
      await dsA.destroy();
      await dsB.destroy();
    });

    it('undo log가 적은 트랜잭션(B)이 victim이 된다', async () => {
      // given - 두 개의 독립된 커넥션에서 트랜잭션 시작
      const qrA = dsA.createQueryRunner();
      const qrB = dsB.createQueryRunner();

      try {
        await qrA.startTransaction();
        await qrB.startTransaction();

        // A: row 1 lock 획득, B: row 2 lock 획득
        await qrA.query('SELECT * FROM deadlock_test WHERE id = 1 FOR UPDATE');
        await qrB.query('SELECT * FROM deadlock_test WHERE id = 2 FOR UPDATE');

        // A: 대량 UPDATE로 undo log 증가 (rollback 비용 높음)
        await qrA.query(
          `UPDATE deadlock_test SET value = value + 1 WHERE id BETWEEN 3 AND ${ROW_COUNT}`,
        );

        // when - A가 먼저 row 2 lock 요청 (대기 시작)
        const promiseA = qrA
          .query('SELECT * FROM deadlock_test WHERE id = 2 FOR UPDATE')
          .then(() => ({ status: 'survived' as const }))
          .catch((e: Error) => ({
            status: 'victim' as const,
            error: e.message,
          }));

        await sleep(100);

        // B가 row 1 lock 요청 → deadlock cycle 형성 → 즉시 감지
        const promiseB = qrB
          .query('SELECT * FROM deadlock_test WHERE id = 1 FOR UPDATE')
          .then(() => ({ status: 'survived' as const }))
          .catch((e: Error) => ({
            status: 'victim' as const,
            error: e.message,
          }));

        const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

        // then - B의 undo log가 적으므로 rollback 비용이 낮은 B가 victim
        expect(resultA.status).toBe('survived');
        expect(resultB.status).toBe('victim');

        if (resultB.status === 'victim') {
          expect(resultB.error).toContain('Deadlock');
        }
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        await qrA.rollbackTransaction().catch(() => {});
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        await qrB.rollbackTransaction().catch(() => {});
        await qrA.release();
        await qrB.release();
      }
    }, 10_000);
  });
});
