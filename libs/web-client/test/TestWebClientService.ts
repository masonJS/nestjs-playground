import { WebClientService } from '@app/web-client/WebClientService';
import { WebClient } from '@app/web-client/http/WebClient';
import { StubWebClient } from './StubWebClient';

export class TestWebClientService extends WebClientService {
  create(url?: string): WebClient {
    return StubWebClient.getInstance(url);
  }
}
