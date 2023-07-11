import { Module } from '@nestjs/common';
import { EventEmitterModule as EEM } from '@nestjs/event-emitter';
import { EventEmitterService } from '@app/event-emitter/EventEmitterService';

@Module({
  imports: [EEM.forRoot()],
  providers: [EventEmitterService],
  exports: [EventEmitterService],
})
export class EventEmitterModule {}
