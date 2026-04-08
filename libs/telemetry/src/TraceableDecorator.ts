import { SetMetadata } from '@nestjs/common';

export const TRACEABLE_METADATA = Symbol('Traceable');

export const Traceable = (): ClassDecorator =>
  SetMetadata(TRACEABLE_METADATA, true);
