import * as fs from 'fs';
import * as path from 'path';
import { Injectable } from '@nestjs/common';
import * as mustache from 'mustache';
import { HtmlTemplateFile } from './enum/HtmlTemplateFile';

@Injectable()
export class HtmlTemplate {
  render(template: HtmlTemplateFile, data: Record<string, unknown>): string {
    const html = fs.readFileSync(
      path.join(__dirname, `/../../public/${template}.hbs`),
    );

    return mustache.render(html.toString(), data);
  }
}
