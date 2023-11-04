import {
  DeepPartial,
  EntityManager,
  getMetadataArgsStorage,
  ObjectLiteral,
} from 'typeorm';
import { FindOneOptions } from 'typeorm/find-options/FindOneOptions';
import { ColumnMetadataArgs } from 'typeorm/metadata-args/ColumnMetadataArgs';
import { faker } from '@faker-js/faker';
import { LocalDateTime, LocalTime } from '@js-joda/core';

export declare type Constructor<T = unknown> = new (...args: any[]) => T;

export abstract class BaseFactory<Entity extends ObjectLiteral> {
  protected abstract entity: Constructor<Entity>;

  constructor(public entityManager: EntityManager) {}

  async save(entity?: DeepPartial<Entity>) {
    return this.entityManager.save(this.makeOne(entity));
  }

  async findOne(options: FindOneOptions<Entity>): Promise<Entity> {
    return await this.entityManager.findOneOrFail(this.entity, options);
  }

  async clear(): Promise<void> {
    return this.entityManager.clear(this.entity);
  }

  protected abstract makeOne(entity?: DeepPartial<Entity>): Entity;

  protected fakeColumns<Entity>(entity: Entity) {
    const fakeColumns: Record<string, any> = {};

    getMetadataArgsStorage()
      .columns.filter((column) => column.target === entity)
      .forEach((column) => {
        if (column.options.nullable || column.propertyName === 'id') {
          return;
        }

        fakeColumns[column.propertyName] = this.mappingFakeColumn(column);
      });

    return fakeColumns;
  }

  protected mappingFakeColumn(column: ColumnMetadataArgs) {
    let result;

    switch (column.options.type) {
      case 'varchar':
      case 'character varying':
      case 'text':
      case String:
        result = faker.datatype.string(20);
        break;

      case 'jsonb':
        result = {};
        break;

      case 'integer':
      case Number:
      case 'bigint':
        result = faker.datatype.number({ min: 1 });
        break;

      case 'boolean':
      case Boolean:
        result = faker.datatype.boolean();
        break;

      case 'timestamptz':
      case 'timestamp with time zone':
        result = LocalDateTime.now();
        break;

      case 'time':
        result = LocalTime.now();
        break;

      default:
        result = 0;
    }

    const isArray =
      column.options.array || Array.isArray(column.options.default);

    return isArray && column.options.type === 'jsonb'
      ? []
      : isArray
      ? [result]
      : result;
  }
}
