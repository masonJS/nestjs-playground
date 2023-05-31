import {
  GetAccessorDeclaration,
  MethodDeclaration,
  Project,
  PropertyDeclaration,
  SourceFile,
  Type,
} from 'ts-morph';
import { SwaggerDecorator } from './swagger-decorator/SwaggerDecorator';
import { NestjsSwaggerDecorator } from './swagger-decorator/NestjsSwaggerDecorator';
import {
  getImportNameType,
  getType,
  isArrayType,
  isOptionalType,
  isPageType,
} from './swagger-type/SwaggerType';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as tsconfig from '../../../../tsconfig.json';

const NESTJS_SWAGGER_MODULE = '@nestjs/swagger';
const CUSTOM_SWAGGER_MODULE = '@app/web-common/res/swagger/ApiOkResponseBy';

export class SwaggerGenerator {
  #project: Project;
  #sourceFiles: SourceFile[];

  constructor(path: string | string[], content?: string) {
    this.#project = new Project({
      compilerOptions: {
        strictNullChecks: tsconfig.compilerOptions.strictNullChecks,
        paths: tsconfig.compilerOptions.paths,
      },
    });

    if (content && typeof path === 'string') {
      this.#sourceFiles = [this.#project.createSourceFile(path, content)];

      return;
    }

    this.#sourceFiles = this.#project.addSourceFilesAtPaths(path);
  }

  addApiPropertyToRequest() {
    this.#sourceFiles.forEach((sourceFile) => {
      const classes = sourceFile.getClasses();

      const isRequestDto = classes.find((classDeclaration) =>
        classDeclaration.getDecorator('RequestDto'),
      );

      if (isRequestDto) {
        this.addImportSwagger(
          sourceFile,
          NestjsSwaggerDecorator.API_PROPERTY,
          NESTJS_SWAGGER_MODULE,
        );
      }

      classes.forEach((classDeclaration) => {
        if (!classDeclaration.getDecorator('RequestDto')) {
          return;
        }

        const properties = classDeclaration.getProperties();

        properties
          .filter((property) => this.canAddApiProperty(property))
          .forEach((property) => this.addApiPropertyToProperty(property));
      });
    });
  }

  addApiPropertyToResponse() {
    this.#sourceFiles.forEach((sourceFile) => {
      const classes = sourceFile.getClasses();

      const isResponseDto = classes.find((classDeclaration) =>
        classDeclaration.getDecorator('ResponseDto'),
      );

      if (isResponseDto) {
        this.addImportSwagger(
          sourceFile,
          NestjsSwaggerDecorator.API_PROPERTY,
          NESTJS_SWAGGER_MODULE,
        );
      }

      classes.forEach((classDeclaration) => {
        if (!classDeclaration.getDecorator('ResponseDto')) {
          return;
        }

        const getters = classDeclaration.getGetAccessors();

        getters
          .filter((property) => this.canAddApiProperty(property))
          .forEach((getter) => this.addApiPropertyToGetter(getter));
      });
    });
  }

  addSwaggerToApi() {
    this.#sourceFiles.forEach((sourceFile) => {
      const classes = sourceFile.getClasses();

      classes.forEach((classDeclaration) => {
        const methods = classDeclaration.getMethods();

        methods
          .filter((method) => !method.hasModifier('private'))
          .forEach((method) => {
            this.addApiOperation(sourceFile, method);
            this.addApiOkResponseBy(sourceFile, method);
          });
      });
    });
  }

  text(): string[] {
    return this.#sourceFiles.map((sourceFile) => sourceFile.getText());
  }

  async save() {
    await this.#project.save();
  }

  private addApiOperation(sourceFile: SourceFile, method: MethodDeclaration) {
    if (method.getDecorator(NestjsSwaggerDecorator.API_OPERATION)) {
      return;
    }

    this.addImportSwagger(
      sourceFile,
      NestjsSwaggerDecorator.API_OPERATION,
      NESTJS_SWAGGER_MODULE,
    );

    method.addDecorator({
      name: NestjsSwaggerDecorator.API_OPERATION,
      arguments: [`{ summary: '' }`],
    });
  }

  private addApiOkResponseBy(
    sourceFile: SourceFile,
    method: MethodDeclaration,
  ) {
    const returnType = method.getReturnType();
    const type = getType(returnType);

    if (!type) {
      return;
    }

    if (
      !method.getDecorator(SwaggerDecorator.API_OK_ARRAY_RESPONSE_BY) &&
      isArrayType(returnType)
    ) {
      this.addImportSwagger(
        sourceFile,
        SwaggerDecorator.API_OK_ARRAY_RESPONSE_BY,
        CUSTOM_SWAGGER_MODULE,
      );

      method.addDecorator({
        name: SwaggerDecorator.API_OK_ARRAY_RESPONSE_BY,
        arguments: [type],
      });

      return;
    }

    if (
      !method.getDecorator(SwaggerDecorator.API_PAGINATE_RESPONSE) &&
      isPageType(returnType)
    ) {
      this.addImportSwagger(
        sourceFile,
        SwaggerDecorator.API_PAGINATE_RESPONSE,
        CUSTOM_SWAGGER_MODULE,
      );

      method.addDecorator({
        name: SwaggerDecorator.API_PAGINATE_RESPONSE,
        arguments: [type],
      });

      return;
    }

    if (
      !method.getDecorator(NestjsSwaggerDecorator.API_RESPONSE) &&
      !isArrayType(returnType) &&
      !isPageType(returnType) &&
      type === 'ResponseEntity'
    ) {
      this.addImportSwagger(
        sourceFile,
        NestjsSwaggerDecorator.API_RESPONSE,
        NESTJS_SWAGGER_MODULE,
      );

      method.addDecorator({
        name: NestjsSwaggerDecorator.API_RESPONSE,
        arguments: [`{ type: ${type} }`],
      });

      return;
    }

    if (
      !method.getDecorator(SwaggerDecorator.API_OK_RESPONSE_BY) &&
      !isArrayType(returnType) &&
      !isPageType(returnType) &&
      type !== 'ResponseEntity'
    ) {
      this.addImportSwagger(
        sourceFile,
        SwaggerDecorator.API_OK_RESPONSE_BY,
        CUSTOM_SWAGGER_MODULE,
      );

      method.addDecorator({
        name: SwaggerDecorator.API_OK_RESPONSE_BY,
        arguments: [type],
      });
    }
  }

  private addApiPropertyToProperty(property: PropertyDeclaration) {
    const propertyType = property.getType();

    const propertyOptions = this.getApiPropertyOptions(propertyType);

    property.addDecorator({
      name: NestjsSwaggerDecorator.API_PROPERTY,
      arguments: propertyOptions.length
        ? [`{ ${propertyOptions.join(', ')} }`]
        : [],
    });
  }

  private addApiPropertyToGetter(getter: GetAccessorDeclaration) {
    const returnType = getter.getReturnType();

    const propertyOptions = this.getApiPropertyOptions(returnType);

    getter.addDecorator({
      name: NestjsSwaggerDecorator.API_PROPERTY,
      arguments: propertyOptions.length
        ? [`{ ${propertyOptions.join(', ')} }`]
        : [],
    });
  }

  private canAddApiProperty(
    property: PropertyDeclaration | GetAccessorDeclaration,
  ) {
    return (
      !property.getDecorator(NestjsSwaggerDecorator.API_PROPERTY) &&
      !property.hasModifier('private') &&
      !property.getDecorator(NestjsSwaggerDecorator.API_HIDE_PROPERTY)
    );
  }

  private getApiPropertyOptions(returnType: Type) {
    const type = getType(returnType);
    const isOptional = isOptionalType(returnType);
    const isEnum = returnType.isEnum() || returnType.isEnumLiteral();

    return [
      type ? `type: ${returnType.isArray() ? `[${type}]` : type}` : undefined,
      isOptional ? `required: ${!isOptional}` : undefined,
      isEnum ? `enum: ${getImportNameType(returnType.getText())}` : undefined,
    ].filter(Boolean);
  }

  private addImportSwagger(
    sourceFile: SourceFile,
    swaggerDecorator: NestjsSwaggerDecorator | SwaggerDecorator,
    swaggerModule: string,
  ) {
    const isImportSwagger = sourceFile
      .getImportDeclarations()
      .some((importDeclaration) =>
        importDeclaration
          .getNamedImports()
          .some((namedImport) => namedImport.getName() === swaggerDecorator),
      );

    if (isImportSwagger) {
      return;
    }

    sourceFile.addImportDeclaration({
      namedImports: [swaggerDecorator],
      moduleSpecifier: swaggerModule,
    });
  }
}
