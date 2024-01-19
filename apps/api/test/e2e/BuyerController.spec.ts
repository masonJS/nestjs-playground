import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import * as http from 'supertest';
import { ReceiveAlarmType } from '@app/entity/domain/buyer/type/ReceiveAlarmType';
import { plainToClass } from 'class-transformer';
import { BuyerCreateRequest } from '../../src/buyer/dto/BuyerCreateRequest';
import { BuyerFactory } from '../../../../libs/entity/test/factory/BuyerFactory';
import { setNestApp } from '../../src/setNestApp';
import { ApiModule } from '../../src/ApiModule';

describe('BuyerController', () => {
  let app: INestApplication;
  let buyerFactory: BuyerFactory;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = module.createNestApplication();
    const em = module.get(EntityManager);
    buyerFactory = new BuyerFactory(em);

    setNestApp(app);

    await app.init();
  });

  beforeEach(async () => buyerFactory.clear());

  afterAll(async () => app.close());

  describe('POST /buyer', () => {
    it('회원가입을 할 수 있다.', async () => {
      // given
      const body = {
        email: 'email',
        password: 'password',
        name: 'name',
        countryNumber: '82',
        phoneNumber: '01012345678',
        receiveAlarmType: ReceiveAlarmType.ALL,
      };
      const request = plainToClass(BuyerCreateRequest, body);

      // when
      const response = await http(app.getHttpServer())
        .post('/api/v1/buyer')
        .send(request);

      // then
      expect(response.status).toBe(201);
    });
  });
});
