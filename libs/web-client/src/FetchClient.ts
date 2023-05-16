import { WebClient } from '@app/web-client/WebClient';
import { MediaType } from '@app/web-client/http/MediaType';
import { BodyInserter } from '@app/web-client/http/BodyInserter';
import { ResponseSpec } from '@app/web-client/http/ResponseSpec';
import { Method } from 'got';

export class FetchClient implements WebClient {
  #url: string;
  #options: RequestInit;
  #timeout: number;

  constructor(url?: string, requestTimeout = 5000) {
    if (url) {
      this.#url = url;
    }
    this.#options = {
      method: 'GET',
    };
    this.#timeout = requestTimeout;
  }

  get(): this {
    this.setMethod('GET');

    return this;
  }

  post(): this {
    this.setMethod('POST');

    return this;
  }

  put(): this {
    this.setMethod('PUT');

    return this;
  }

  patch(): this {
    this.setMethod('PATCH');

    return this;
  }

  delete(): this {
    this.setMethod('DELETE');

    return this;
  }

  url(url: string): this {
    this.#url = url;
    return this;
  }

  header(param: Record<string, string>): this {
    this.#options.headers = param;
    return this;
  }

  accept(mediaType: MediaType): this {
    this.#options.headers = {
      ...this.#options.headers,
      'Content-Type': mediaType,
    };

    return this;
  }

  body<T>(body: BodyInserter<T>): this {
    this.accept(body.mediaType);

    switch (body.mediaType) {
      case MediaType.APPLICATION_JSON:
        this.#options.body = JSON.stringify(body.data);
        break;
      case MediaType.APPLICATION_FORM_URLENCODED:
        this.#options.body = new URLSearchParams(body.data as any);
        break;
      default:
        this.#options.body = body.data as any;
    }

    return this;
  }

  timeout(timeout: number): this {
    this.#timeout = timeout;
    return this;
  }

  async retrieve(): Promise<ResponseSpec> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeout);
      const response = await fetch(this.#url, {
        ...this.#options,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      return new ResponseSpec(response.status, await response.text());
    } catch (e) {
      throw new Error(e);
    }
  }

  private setMethod(method: Method): this {
    this.#options.method = method;
    return this;
  }
}
