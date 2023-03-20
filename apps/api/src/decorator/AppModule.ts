import {
  applyDecorators,
  Module,
  ModuleMetadata,
  SetMetadata,
} from '@nestjs/common';
import { EntityModule } from '@app/entity/EntityModule';

export const AppModule = (module: ModuleMetadata) =>
  applyDecorators(
    SetMetadata('appModule', module),
    Module({
      ...module,
      imports: [...(module.imports || []), EntityModule],
    }),
  );
