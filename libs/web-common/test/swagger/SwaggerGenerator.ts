import { Project, SourceFile } from 'ts-morph';

export class SwaggerGenerator {
  #sourceFiles: SourceFile[];

  constructor(path: string, sourceFileText?: any) {
    const project = new Project({
      compilerOptions: {
        strictNullChecks: true,
      },
    });

    if (sourceFileText) {
      const sourceFile = project.createSourceFile(path, sourceFileText);
      this.#sourceFiles = [sourceFile];
      return;
    }

    this.#sourceFiles = project.addSourceFilesAtPaths(path);
  }

  addApiPropertyToResponse(): SourceFile[] {
    this.#sourceFiles.forEach((sourceFile) => {
      sourceFile.getClasses().forEach((classDeclaration) => {
        const getAccessors = classDeclaration.getGetAccessors();

        getAccessors
          .filter((accessor) => !accessor.getDecorator('ApiProperty'))
          .forEach((accessor) => {
            // add @ApiProperty decorator in get Accessor
            accessor.addDecorator({
              name: 'ApiProperty',
              arguments: [],
            });
          });
      });
    });

    return this.#sourceFiles;
  }

  save() {
    this.#sourceFiles.forEach((sourceFile) => {
      sourceFile.saveSync();
    });
  }
}
