import { Module } from '@nestjs/common';
import { HtmlTemplate } from '@app/template/html/HtmlTemplate';

@Module({
  providers: [HtmlTemplate],
})
export class TemplateModule {}
