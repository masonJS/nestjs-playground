import { SwaggerGenerator } from './SwaggerGenerator';

describe('swagger swagger-decorator 를 생성', () => {
  it('*Response.ts 파일에 대한 getter 프로퍼티에 @ApiProperty 데코레이터를 생성한다.', async () => {
    const responseFiles = process.argv
      .slice(3, process.argv.length)
      .filter((fileName) => fileName.endsWith('Response.ts'));

    if (!responseFiles.length) {
      return;
    }

    const generator = new SwaggerGenerator(responseFiles);

    generator.addApiPropertyToResponse();
    await generator.save();
  });

  it('*Request.ts 파일에 대한 프로퍼티에 @ApiProperty 데코레이터를 생성한다.', async () => {
    const requestFiles = process.argv
      .slice(3, process.argv.length)
      .filter((fileName) => fileName.endsWith('Request.ts'));

    if (!requestFiles.length) {
      return;
    }

    const generator = new SwaggerGenerator(requestFiles);

    generator.addApiPropertyToRequest();
    await generator.save();
  });

  it('*Controller.ts 파일에 대한 프로퍼티에 swagger 데코레이터를 생성한다.', async () => {
    const controllerFiles = process.argv
      .slice(3, process.argv.length)
      .filter((fileName) => fileName.endsWith('Controller.ts'));

    if (!controllerFiles.length) {
      return;
    }

    const generator = new SwaggerGenerator(controllerFiles);

    generator.addSwaggerToApi();
    await generator.save();
  }, 20000);
});
