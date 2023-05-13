export class UrlBuilder {
  #url: string;
  #queryList: URLSearchParams;

  constructor() {
    this.#queryList = new URLSearchParams();
  }

  url(url: string): this {
    this.#url = url;

    return this;
  }

  queryParam(key: string, value: string): this {
    this.#queryList.append(key, value);

    return this;
  }

  build(): string {
    return `${this.#url}?${this.#queryList.toString()}`;
  }
}
