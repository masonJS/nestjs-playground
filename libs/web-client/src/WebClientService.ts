import { WebClient } from '@app/web-client/http/WebClient';

export abstract class WebClientService {
  abstract create(url?: string): WebClient;
}
