import { TypeOrmModule } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from '@app/entity/config/SnakeNamingStrategy';

export function getPgRealTypeOrmModule() {
  return TypeOrmModule.forRoot({
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    username: 'test',
    password: 'test',
    database: 'test',
    connectTimeoutMS: 5000,
    autoLoadEntities: true,
    logging: false,
    namingStrategy: new SnakeNamingStrategy(),
    extra: {
      statement_timeout: 5000,
      idle_in_transaction_session_timeout: 5000,
    },
  });
}
