import { WebClientService } from '@app/web-client/WebClientService';
import { WebClient } from '@app/web-client/http/WebClient';
import { GotClient } from '@app/web-client/http/GotClient';

export class GotWebClientService extends WebClientService {
  create(url?: string): WebClient {
    return new GotClient(url);
  }
}
