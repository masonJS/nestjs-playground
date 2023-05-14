import { MediaType } from '@app/web-client/http/MediaType';
import { BodyInserter } from '@app/web-client/http/BodyInserter';
import { ResponseSpec } from '@app/web-client/http/ResponseSpec';

export abstract class WebClient {
  abstract get(): this;

  abstract post(): this;

  abstract put(): this;

  abstract patch(): this;

  abstract delete(): this;

  abstract uri(url: string): this;

  abstract accept(mediaType: MediaType): this;

  abstract header(param: Record<string, string | string[]>): this;

  abstract body<T>(body: BodyInserter<T>): this;

  abstract timeout(timeout: number): this;

  abstract retrieve(): Promise<ResponseSpec>;
}
