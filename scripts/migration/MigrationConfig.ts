import { Configuration } from '@app/config/Configuration';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '@app/entity/config/SnakeNamingStrategy';

const dbEnv = Configuration.getEnv().database;

export default new DataSource({
  type: 'postgres',
  host: dbEnv.readerHost,
  port: dbEnv.port,
  username: dbEnv.user,
  password: dbEnv.password,
  database: dbEnv.name,
  entities: ['libs/entity/src/domain/**/*.entity.ts'],
  namingStrategy: new SnakeNamingStrategy(),
  migrations: ['scripts/migration/*-Migration.ts'],
});
