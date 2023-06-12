import * as pdfjs from 'pdfjs-dist';
import { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { TextItem } from 'pdfjs-dist/types/src/display/api';
import { Injectable } from '@nestjs/common';
import { PdfParserDto } from '@app/file-manager/dto/PdfParserDto';

@Injectable()
export class PDFParser {
  async create(buffer: Buffer): Promise<PdfParserDto> {
    const uint8Array = new Uint8Array(buffer);
    const pdfDocument = await pdfjs.getDocument(uint8Array).promise;

    const pages = await this.getPages(pdfDocument);
    const text = await this.getText(pages);

    return PdfParserDto.of(pdfDocument.numPages, text);
  }

  private async getText(pages: PDFPageProxy[]) {
    const textContents = await Promise.all(
      pages.map(async (page) => await page.getTextContent()),
    );

    return textContents
      .map((textContent) =>
        textContent.items.map((item) => (item as TextItem).str.trim()).join(''),
      )
      .join('');
  }

  private async getPages(pdfDocument: PDFDocumentProxy) {
    return await Promise.all(
      Array.from(
        { length: pdfDocument.numPages },
        async (_, i) => await pdfDocument.getPage(i + 1),
      ),
    );
  }
}
