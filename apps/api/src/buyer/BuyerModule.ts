import { AppModule } from '../decorator/AppModule';
import { BuyerController } from './BuyerController';
import { BuyerService } from './BuyerService';
import { BuyerRepository } from './BuyerRepository';
import { EventEmitterModule } from '@app/event-emitter/EventEmitterModule';

@AppModule({
  imports: [EventEmitterModule],
  providers: [BuyerService, BuyerRepository],
  controllers: [BuyerController],
})
export class BuyerModule {}
