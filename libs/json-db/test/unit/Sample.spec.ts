import { Config, JsonDB } from 'node-json-db';

describe('sample', () => {
  let db: JsonDB;

  beforeAll(async () => {
    db = new JsonDB(new Config('testDataBase'));
  });

  beforeEach(async () => {
    await db.delete('/');
  });

  it('해당 테이블에 칼럼을 추가할수 있다.', async () => {
    // given
    const userTable = 'user';

    // when
    await db.push(`/${userTable}`, { column: 'test' });

    // then
    const result = await db.getObject<{ column: string }>(`/${userTable}`);
    expect(result).toEqual({ column: 'test' });
  });

  it('해당 테이블에 칼럼을 추가할수 있다.', async () => {
    // given
    const userTable = 'user';
    await db.push(`/${userTable}`, { column: 'test' });

    // when
    await db.push(`/${userTable}`, { column: 'new test' });

    // then
    const result = await db.getObject<{ test: string }>(`/${userTable}`);
    expect(result).toEqual({ column: 'new test' });
  });

  it('해당 테이블에 array 칼럼에 데이터를 push할수 있다.', async () => {
    // given
    const userTable = 'user';
    await db.push(`/${userTable}`, { column: 'test' });

    // when
    await db.push(`/${userTable}`, { column: 'new test' });

    // then
    const result = await db.getObject<{ test: string }>(`/${userTable}`);
    expect(result).toEqual({ column: 'new test' });
  });

  it('push test', async () => {
    // By default 기존 값을 덮어쓴다.
    await db.push('/test', { test: 'test' }, false);

    // 존재하지 않는 데이터 경로에 대한 새 데이터를 푸시하면 자동으로 계층이 생성됩니다.
    await db.push('/test/my/test', 1);

    await db.push('/test3', { test: 'test', json: { test: ['test'] } });

    // 덮어쓰지 않고 병합 처리
    await db.push(
      '/test3',
      {
        new: 'cool',
        json: {
          important: 5,
        },
      },
      false,
    );
  });

  it('array support', async () => {
    await db.push('/array/myarray[]', {
      obj: 'test',
    });

    // append
    await db.push('/array/myarray[]', {
      obj: 'test',
    });

    // get
    const myArray = await db.getData('/array/myarray');
    expect(myArray).toEqual([
      {
        obj: 'test',
      },
      {
        obj: 'test',
      },
    ]);

    // remove
    await db.delete('/array/myarray[0]');
    const result = await db.getData('/array/myarray');
    expect(result).toEqual([
      {
        obj: 'test',
      },
    ]);
  });
});
