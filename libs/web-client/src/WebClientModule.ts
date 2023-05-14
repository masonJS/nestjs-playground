import { Module } from '@nestjs/common';
import { WebClientService } from '@app/web-client/WebClientService';
import { GotWebClientService } from '@app/web-client/GotWebClientService';

@Module({
  providers: [
    {
      provide: WebClientService,
      useClass: GotWebClientService,
    },
  ],
  exports: [WebClientService],
})
export class WebClientModule {}
