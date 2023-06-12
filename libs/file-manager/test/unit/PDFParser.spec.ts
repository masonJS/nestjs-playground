import { PDFDocument } from 'pdf-lib';
import { PDFParser } from '@app/file-manager/pdf/PDFParser';

describe('PdfParser', () => {
  it('pdf 파일의 텍스트와 페이지 수를 반환한다.', async () => {
    // given
    const pdfBuffer = await createPdfBuffer('pdf');
    const pdfParser = new PDFParser();

    // when
    const result = await pdfParser.create(pdfBuffer);

    // then
    expect(result.text).toBe('pdf');
    expect(result.totalPage).toBe(1);
  });
});

async function createPdfBuffer(text: string) {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  page.drawText(text, {});
  const pdfBytes = await doc.save();

  return Buffer.from(pdfBytes);
}
