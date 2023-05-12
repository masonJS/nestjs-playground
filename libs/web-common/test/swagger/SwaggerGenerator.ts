import {
  GetAccessorDeclaration,
  Project,
  PropertyDeclaration,
  SourceFile,
  Type,
} from 'ts-morph';

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

  addApiPropertyToRequest() {
    this.#sourceFiles.forEach((sourceFile) => {
      this.addImportApiProperty(sourceFile);
      const classes = sourceFile.getClasses();

      classes.forEach((classDeclaration) => {
        const properties = classDeclaration.getProperties();

        properties
          .filter((property) => !property.getDecorator('ApiProperty'))
          .forEach((property) => this.addApiPropertyToProperty(property));
      });
    });
  }

  addApiPropertyToResponse() {
    this.#sourceFiles.forEach((sourceFile) => {
      this.addImportApiProperty(sourceFile);
      const classes = sourceFile.getClasses();

      classes.forEach((classDeclaration) => {
        const getters = classDeclaration.getGetAccessors();

        getters
          .filter((getter) => !getter.getDecorator('ApiProperty'))
          .forEach((getter) => this.addApiPropertyToGetter(getter));
      });
    });
  }

  text(): string[] {
    return this.#sourceFiles.map((sourceFile) => sourceFile.getText());
  }

  async save() {
    await this.#project.save();
  }

  private addApiPropertyToProperty(property: PropertyDeclaration) {
    const propertyType = property.getType();

    const propertyOptions = this.getApiPropertyOptions(propertyType);

    property.addDecorator({
      name: 'ApiProperty',
      arguments: propertyOptions.length
        ? [`{ ${propertyOptions.join(', ')} }`]
        : [],
    });
  }

  private addApiPropertyToGetter(getter: GetAccessorDeclaration) {
    const returnType = getter.getReturnType();

    const propertyOptions = this.getApiPropertyOptions(returnType);

    getter.addDecorator({
      name: 'ApiProperty',
      arguments: propertyOptions.length
        ? [`{ ${propertyOptions.join(', ')} }`]
        : [],
    });
  }

  private getApiPropertyOptions(returnType: Type) {
    const type = this.getTypeReferenceAsString(returnType);
    const isOptional = this.isOptionalProperty(returnType);
    const isEnum = returnType.isEnum() || returnType.isEnumLiteral();

    return [
      type ? `type: ${type}` : undefined,
      isOptional ? `required: ${!isOptional}` : undefined,
      isEnum
        ? `enum: ${this.getImportNameType(returnType.getText())}`
        : undefined,
    ].filter(Boolean);
  }

  private getTypeReferenceAsString(type: Type): string | undefined {
    if (type.isArray()) {
      const arrayType = type.getArrayElementType();

      if (!arrayType) {
        return undefined;
      }
      const elementType = this.getTypeReferenceAsString(arrayType);

      return `[${elementType}]`;
    }

    if (type.isBoolean()) {
      return Boolean.name;
    }

    if (type.isNumber()) {
      return Number.name;
    }

    if (type.isEnum() || type.isEnumLiteral()) {
      return undefined;
    }

    if (type.isString() || type.isStringLiteral()) {
      return String.name;
    }

    if (type.isUnion()) {
      const unionTypes = type.getUnionTypes();

      return this.getTypeReferenceAsString(unionTypes[unionTypes.length - 1]);
    }

    if (type.isClass()) {
      return this.getImportNameType(type.getText());
    }

    const text = type.getText();

    if (text === Date.name) {
      return text;
    }

    if (text === 'any' || text === 'unknown' || text === 'object') {
      return 'Object';
    }

    return undefined;
  }

  private isOptionalProperty(type: Type): boolean {
    if (type.isUnion()) {
      const unionTypes = type.getUnionTypes();

      return unionTypes.some(
        (type) =>
          type.getText().includes('undefined') ||
          type.getText().includes('null'),
      );
    }

    return type.isUndefined() || type.isNull();
  }

  // import('...').ClassA 형태에서 named import인 ClassA 만 가져오도록 한다.
  private getImportNameType(textType: string) {
    if (!textType.includes('import(')) {
      return textType;
    }

    return textType.split('.')[1];
  }

  private addImportApiProperty(sourceFile: SourceFile) {
    const isImportApiProperty = sourceFile
      .getImportDeclarations()
      .some((importDeclaration) =>
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
