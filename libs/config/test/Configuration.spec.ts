import { Test } from '@nestjs/testing';
import { Configuration } from '../src/Configuration';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../src/env/Environment';

describe('Configuration', () => {
  let configService: ConfigService<Environment>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [Configuration.getModule()],
    }).compile();

    configService = module.get(ConfigService);
  });

  it('정상적으로 환경변수를 가져온다', () => {
    // given, when
    const dbEnv = configService.get('database', { infer: true });

    // then
    expect(dbEnv).toMatchInlineSnapshot(`
      DatabaseEnvironment {
        "connectTimeoutMS": 5000,
        "idleInTransactionSessionTimeout": 30000,
        "masterHost": "localhost",
        "name": "test",
        "password": "test",
        "port": 5434,
        "readerHost": "localhost",
        "statementTimeout": 5000,
        "user": "test",
      }
    `);
  });
});
