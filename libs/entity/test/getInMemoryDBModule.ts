import { join } from 'path';
import { IBackup, IMemoryDb, newDb } from 'pg-mem';
import { DataSource } from 'typeorm';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { ModuleMetadata } from '@nestjs/common';
import { EntityModule } from '@app/entity/EntityModule';
import { SnakeNamingStrategy } from '@app/entity/config/SnakeNamingStrategy';
import { TypeOrmModule } from '@nestjs/typeorm';

export class InMemoryDBModule {
  static db: IMemoryDb;
  static backup: IBackup;
  static datasource: DataSource;
  static testingModuleBuilder: TestingModuleBuilder;

  static async connect(
    metadata: ModuleMetadata,
    overrideFn: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) =>
      b,
  ) {
    this.db = newDb({
      autoCreateForeignKeyIndices: false,
    });

    this.db.public.registerFunction({
      name: 'current_database',
      implementation: () => 'test',
    });

    this.datasource = this.db.adapters.createTypeormDataSource({
      type: 'postgres',
      entities: [join(__dirname, '../src/domain/**/*.entity.ts')],
      synchronize: true,
      namingStrategy: new SnakeNamingStrategy(),
    });

    await this.datasource.synchronize();

    this.backup = this.db.backup();

    this.testingModuleBuilder = Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(),
        EntityModule,
        ...(metadata.imports || []),
      ],
      controllers: metadata.controllers,
      providers: metadata.providers,
    })
      .overrideProvider(DataSource)
      .useValue(this.datasource);

    return overrideFn(this.testingModuleBuilder).compile();
  }

  static restore() {
    this.backup.restore();
  }

  static async disconnect() {
    await this.datasource.destroy();
  }
}
