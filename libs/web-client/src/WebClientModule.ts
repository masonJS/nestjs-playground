import { Module } from '@nestjs/common';
import { WebClientService } from '@app/web-client/creator/WebClientService';
import { GotClientService } from '@app/web-client/creator/GotClientService';

@Module({
  providers: [
    {
      provide: WebClientService,
      useClass: GotClientService,
    },
  ],
  exports: [WebClientService],
})
export class WebClientModule {}
