import { MediaType } from '@app/web-client/http/MediaType';
import { BodyInserter } from '@app/web-client/http/BodyInserter';
import { ResponseSpec } from '@app/web-client/http/ResponseSpec';
import { RetryPolicy } from '@app/web-client/retry/RetryPolicy';

export interface WebClient {
  get(): this;

  post(): this;

  put(): this;

  patch(): this;

  delete(): this;

  url(url: string): this;

  accept(mediaType: MediaType): this;

  header(param: Record<string, string | string[]>): this;

  body<T>(body: BodyInserter<T>): this;

  timeout(timeout: number): this;

  retry(policy: RetryPolicy): this;

  retrieve(): Promise<ResponseSpec>;
}
