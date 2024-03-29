import { TypeOrmModule } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from '@app/entity/config/SnakeNamingStrategy';
import { Configuration } from '@app/config/Configuration';

export function getRealDBModule() {
  const database = Configuration.getEnv().database;

  return TypeOrmModule.forRoot({
    type: 'postgres',
    host: database.masterHost,
    port: database.port,
    username: database.user,
    password: database.password,
    database: database.name,
    connectTimeoutMS: database.connectTimeoutMS,
    autoLoadEntities: true,
    logging: false,
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: true,
    extra: {
      statement_timeout: database.statementTimeout,
      idle_in_transaction_session_timeout:
        database.idleInTransactionSessionTimeout,
    },
  });
}
