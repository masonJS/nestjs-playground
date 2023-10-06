import { HtmlTemplate } from '@app/template/html/HtmlTemplate';
import { HtmlTemplateFile } from '@app/template/html/enum/HtmlTemplateFile';

describe('HtmlTemplate', () => {
  it('템플릿 파일과 데이터를 통해 html 파일을 만든다.', () => {
    // given
    const htmlTemplate = new HtmlTemplate();

    // when
    const result = htmlTemplate.render(HtmlTemplateFile.SAMPLE, {
      title: 'sample title',
      name: 'sample name',
      content: 'sample content',
    });

    // then
    expect(result).toContain('sample title');
    expect(result).toContain('sample name');
    expect(result).toContain('sample content');
  });
});
