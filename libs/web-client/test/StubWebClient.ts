import { WebClient } from '@app/web-client/http/WebClient';
import { MediaType } from '@app/web-client/http/MediaType';
import { BodyInserter } from '@app/web-client/http/BodyInserter';
import { Method } from 'got';
import { ResponseSpec } from '@app/web-client/http/ResponseSpec';

export class StubWebClient implements WebClient {
  private static instance: StubWebClient;

  urls: string[] = [];
  headerList: Record<string, string | string[] | undefined>[] = [];
  methods: Method[] = [];
  requestBodies: string[] = [];
  requestCount = 0;
  requestTimeout = 5000;

  responses: {
    statusCode: number;
    body: string;
    error?: any;
  }[];

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  static getInstance(url?: string): StubWebClient {
    if (!StubWebClient.instance) {
      StubWebClient.instance = new StubWebClient();
    }

    if (url) {
      StubWebClient.instance.uri(url);
    }

    return StubWebClient.instance;
  }

  get(): this {
    this.methods.push('GET');

    return this;
  }

  post(): this {
    this.methods.push('POST');

    return this;
  }

  put(): this {
    this.methods.push('PUT');

    return this;
  }

  patch(): this {
    this.methods.push('PATCH');

    return this;
  }

  delete(): this {
    this.methods.push('DELETE');

    return this;
  }

  uri(url: string): this {
    this.urls.push(url);

    return this;
  }

  header(param: Record<string, string | string[]>): this {
    this.headerList.push(param);

    return this;
  }

  accept(mediaType: MediaType): this {
    this.headerList.push({
      ...this.headerList.at(-1),
      'Content-Type': mediaType,
    });

    return this;
  }

  body<T>(body: BodyInserter<T>): this {
    this.accept(body.mediaType);
    this.requestBodies.push(this.parseBody(body.data as any));

    return this;
  }

  timeout(timeout: number): this {
    this.requestTimeout = timeout;
    return this;
  }

  async retrieve(): Promise<ResponseSpec> {
    this.requestCount += 1;

    const response = this.responses.shift();

    if (!response) {
      throw new Error('설정된 응답값이 없습니다');
    }

    if (response.error) {
      throw response.error;
    }

    return new ResponseSpec(response.statusCode, response.body);
  }

  private parseBody(
    body: Record<string, unknown> | string | Buffer | object,
  ): string {
    if (typeof body === 'string' || body instanceof Buffer) {
      return body.toString();
    }

    return JSON.stringify(body);
  }
}
