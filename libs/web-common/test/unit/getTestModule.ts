import { INJECTABLE_WATERMARK } from '@nestjs/common/constants';
import { Provider } from '@nestjs/common/interfaces/modules/provider.interface';
import { getMetadataArgsStorage } from 'typeorm';
import { ModuleMetadata } from '@nestjs/common';
import { EntityModule } from '@app/entity/EntityModule';

type Type<T = any> = new (...args: any[]) => T;

export function getInjectedProviders(
  provider: Type,
  addProviders?: Provider[],
) {
  let injectProviders: Type[] =
    Reflect.getMetadata('design:paramtypes', provider) ?? [];

  injectProviders = injectProviders.filter(
    (injectProvider) =>
      Reflect.hasMetadata(INJECTABLE_WATERMARK, injectProvider) ||
      getMetadataArgsStorage().entityRepositories.find(
        (repository) => repository.target === injectProvider,
      ),
  );

  return [...injectProviders, provider, ...(addProviders ?? [])];
}

export function getTestModule(
  provider: Type,
  metadata: ModuleMetadata,
): ModuleMetadata {
  return {
    imports: [...(metadata.imports || []), EntityModule],
    controllers: [...(metadata.controllers ?? [])],
    providers: getInjectedProviders(provider, metadata.providers),
    exports: [...(metadata.exports ?? [])],
  };
}
