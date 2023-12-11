import { Inject, Injectable } from '@nestjs/common';
import { BizMessageEnvironment } from '@app/config/env/BizMessageEnvironment';
import { Logger } from '@app/logger/Logger';
import { WebClientService } from '@app/web-client/creator/WebClientService';
import { AlimtalkSenderDto } from '@app/notification-manager/kakao/dto/AlimtalkSenderDto';
import { BodyInserter } from '@app/web-client/http/BodyInserter';

@Injectable()
export class KakaoSenderService {
  constructor(
    @Inject('CONFIG') readonly env: BizMessageEnvironment,
    private readonly logger: Logger,
    private readonly webClientService: WebClientService,
  ) {}

  async sendAlimtalk(dto: AlimtalkSenderDto) {
    try {
      await Promise.all(
        dto.toRequestBodies.map(async (body) =>
          this.webClientService
            .create(this.env.alimtalkEndpoint)
            .post()
            .header({ 'X-Sender-Key': this.env.secretKey })
            .body(
              BodyInserter.fromJSON({ ...body, senderKey: this.env.senderKey }),
            )
            .retrieve(),
        ),
      );
    } catch (e) {
      this.logger.error(
        `kakao alimTalk error request=${JSON.stringify(dto.toRequestBodies)}`,
        e,
      );

      throw new Error('kakao alimTalk error');
    }
  }
}
