import { MediaType } from '@app/web-client/http/MediaType';

export abstract class WebClient {
  abstract get(): this;

  abstract post(): this;

  abstract put(): this;

  abstract patch(): this;

  abstract delete(): this;

  abstract uri(url: string): this;

  abstract accept(mediaType: MediaType): this;

  abstract header(param: Record<string, string | string[]>): this;

  abstract body(body: any): this;

  abstract retrieve(): Promise<any>;
}
