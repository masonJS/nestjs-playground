import { Table } from 'typeorm';
import { SnakeNamingStrategy as DefaultSnakeNamingStrategy } from 'typeorm-naming-strategies';

export class SnakeNamingStrategy extends DefaultSnakeNamingStrategy {
  constructor() {
    super();
  }

  override primaryKeyName(
    tableOrName: Table | string,
    columnNames: string[],
  ): string {
    const table = tableOrName instanceof Table ? tableOrName.name : tableOrName;
    const columnsSnakeCase = columnNames.join('_');

    return `pk_${table}_${columnsSnakeCase}`;
  }
}
