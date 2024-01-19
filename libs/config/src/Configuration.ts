import { readFileSync } from 'fs';
import * as process from 'process';
import * as yaml from 'js-yaml';
import { plainToClass } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ConfigModule } from '@nestjs/config';
import { Environment } from '@app/config/env/Environment';

export class Configuration {
  static getModule() {
    return ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      load: [() => Configuration.getEnv()],
    });
  }

  static getEnv(nodeEnv?: string): Environment {
    const environment = this.getEnvByYml(nodeEnv);
    this.validate(environment);

    return environment;
  }

  private static getEnvByYml(nodeEnv = process.env.NODE_ENV): Environment {
    const suffix = !nodeEnv || nodeEnv === 'test' ? 'local' : nodeEnv;
    const yml = yaml.load(readFileSync(`env/env.${suffix}.yml`, 'utf8'));

    return plainToClass(Environment, yml);
  }

  private static validate(environment: Environment) {
    const errors = validateSync(environment);

    if (errors.length > 0) {
      throw new Error(errors.toString());
    }
  }
}
