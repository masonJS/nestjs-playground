import { AppModule } from '../decorator/AppModule';
import { BuyerController } from './BuyerController';
import { BuyerService } from './BuyerService';
import { BuyerRepository } from './BuyerRepository';

@AppModule({
  imports: [],
  providers: [BuyerService, BuyerRepository],
  controllers: [BuyerController],
})
export class BuyerModule {}
