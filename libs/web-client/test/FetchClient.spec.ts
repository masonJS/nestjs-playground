import { Server } from 'http';
import { AddressInfo } from 'net';
import { FetchClient } from '@app/web-client/FetchClient';
import { BodyInserter } from '@app/web-client/http/BodyInserter';
import FakeHttpServer from './fixture/FakeHttpServer';

describe('FetchClient', () => {
  let server: Server;
  let url: string;

  beforeAll(() => {
    server = FakeHttpServer.listen(0);
    const port = (server.address() as AddressInfo).port;
    url = `http://localhost:${port}`;
  });

  afterAll((done) => {
    server.close(() => done());
  });

  describe('url', () => {
    it('url 을 설정한다', async () => {
      // given
      const client = new FetchClient();

      // when
      const response = await client.url(url + '/api').retrieve();

      // then
      expect(response.statusCode).toBe(200);
      expect(response.rawBody).toBe('body');
    });

    it('인스턴스 초기화했을때 url을 설정할수 있다.', async () => {
      // given
      const client = new FetchClient(url + '/api');

      // when
      const response = await client.retrieve();

      // then
      expect(response.statusCode).toBe(200);
      expect(response.rawBody).toBe('body');
    });

    it('url 메소드로 설정을 오버라이딩할수 있다.', async () => {
      // given
      const client = new FetchClient('invalid url');

      // when
      const response = await client.url(url + '/api').retrieve();

      // then
      expect(response.statusCode).toBe(200);
      expect(response.rawBody).toBe('body');
    });
  });

  it.each(['get', 'post', 'put', 'patch', 'delete'] as const)(
    '%s 메소드로 데이터를 조회할 수 있다.',
    async (httpMethod) => {
      // given
      const client = new FetchClient(url + '/api');

      // when
      const response = await client[httpMethod]().retrieve();
      // then
      expect(response.statusCode).toBe(200);
      expect(response.rawBody).toBe('body');
    },
  );

  it('timeout만큼 설정된 시간이 초과된경우 에러를 발생한다.', async () => {
    // given
    const client = new FetchClient(url + '/timeout');

    // when
    const exchange = async () => await client.timeout(500).retrieve();

    // then
    await expect(exchange).rejects.toThrow();
  }, 2000);

  describe('body', () => {
    it('json 데이터로 요청을 보낼수 있다.', async () => {
      // given
      const client = new FetchClient(url + '/param');

      // when
      const response = await client
        .post()
        .body(BodyInserter.fromJSON({ key: 'value' }))
        .retrieve();

      // then
      expect(response.statusCode).toBe(200);
      expect(response.rawBody).toMatchInlineSnapshot(
        `"{"query":{},"body":{"key":"value"}}"`,
      );
    });

    it('form 데이터로 요청을 보낼수 있다.', async () => {
      // given
      const client = new FetchClient(url + '/param');

      // when
      const response = await client
        .post()
        .body(BodyInserter.fromFormData({ key: 'value' }))
        .retrieve();

      // then
      expect(response.statusCode).toBe(200);
      expect(response.rawBody).toMatchInlineSnapshot(
        `"{"query":{},"body":{"key":"value"}}"`,
      );
    });
  });
});
