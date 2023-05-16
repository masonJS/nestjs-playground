import { WebClientService } from '@app/web-client/creator/WebClientService';
import { WebClient } from '@app/web-client/WebClient';
import { GotClient } from '@app/web-client/GotClient';

export class GotClientService extends WebClientService {
  create(url?: string): WebClient {
    return new GotClient(url);
  }
}
