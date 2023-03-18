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
    expect(dbEnv).toMatchInlineSnapshot(
      `
      DatabaseEnvironment {
        "database": "test",
        "masterHost": "localhost",
        "password": "test",
        "port": 5432,
        "readerHost": "localhost",
        "user": "test",
      }
    `,
    );
  });
});
