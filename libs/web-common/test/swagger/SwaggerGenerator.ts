import { GetAccessorDeclaration, Project, SourceFile, Type } from 'ts-morph';

export class SwaggerGenerator {
  #project: Project;
  #sourceFiles: SourceFile[];

  constructor(path: string | string[], content?: string) {
    this.#project = new Project({
      compilerOptions: { strictNullChecks: true },
    });

    if (content && typeof path === 'string') {
      this.#sourceFiles = [this.#project.createSourceFile(path, content)];

      return;
    }

    this.#sourceFiles = this.#project.addSourceFilesAtPaths(path);
  }

  addApiPropertyToResponse() {
    this.#sourceFiles.forEach((sourceFile) => {
      this.addImportApiProperty(sourceFile);
      const classes = sourceFile.getClasses();

      classes.forEach((classDeclaration) => {
        const getters = classDeclaration.getGetAccessors();

        getters
          .filter((getter) => !getter.getDecorator('ApiProperty'))
          .forEach((getter) => this.addApiProperty(getter));
      });
    });
  }

  text(): string[] {
    return this.#sourceFiles.map((sourceFile) => sourceFile.getText());
  }

  async save() {
    await this.#project.save();
  }

  private addApiProperty(getter: GetAccessorDeclaration) {
    const returnType = getter.getReturnType();
    const isOptional = this.isOptionalProperty(returnType);

    const isArray = returnType.isArray();
    const arrayType = returnType.getArrayElementType();

    getter.addDecorator({
      name: 'ApiProperty',
      arguments: [
        `{ type: ${
          isArray ? arrayType?.getText() : returnType.getText()
        }, required: ${!isOptional} ${isArray ? ', isArray: true' : ''}  }`,
      ],
    });
  }

  private isOptionalProperty(returnType: Type): boolean {
    if (returnType.isUnion()) {
      const unionTypes = returnType.getUnionTypes();

      return unionTypes.some(
        (type) =>
          type.getText().includes('undefined') ||
          type.getText().includes('null'),
      );
    }

    return returnType.isUndefined() || returnType.isNull();
  }

  private addImportApiProperty(sourceFile: SourceFile) {
    const importDeclaration = sourceFile.getImportDeclarations();

    const isImportApiProperty = importDeclaration.some((importDeclaration) =>
      importDeclaration
        .getNamedImports()
        .some((namedImport) => namedImport.getName() === 'ApiProperty'),
    );

    if (isImportApiProperty) {
      return;
    }

    sourceFile.addImportDeclaration({
      namedImports: ['ApiProperty'],
      moduleSpecifier: '@nestjs/swagger',
    });
  }
}
