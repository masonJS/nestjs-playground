export class PdfParserDto {
  private readonly _totalPage: number;

  private readonly _text: string;

  private constructor(totalPage: number, text: string) {
    this._totalPage = totalPage;
    this._text = text;
  }

  static of(totalPage: number, text: string) {
    return new PdfParserDto(totalPage, text);
  }

  get totalPage(): number {
    return this._totalPage;
  }

  get text(): string {
    return this._text;
  }
}
