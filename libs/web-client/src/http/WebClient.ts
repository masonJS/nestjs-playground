import { MediaType } from '@app/web-client/http/MediaType';
import { BodyInserter } from '@app/web-client/http/BodyInserter';
import { ResponseSpec } from '@app/web-client/http/ResponseSpec';

export interface WebClient {
  get(): this;

  post(): this;

  put(): this;

  patch(): this;

  delete(): this;

  uri(url: string): this;

  accept(mediaType: MediaType): this;

  header(param: Record<string, string | string[]>): this;

  body<T>(body: BodyInserter<T>): this;

  timeout(timeout: number): this;

  retrieve(): Promise<ResponseSpec>;
}
