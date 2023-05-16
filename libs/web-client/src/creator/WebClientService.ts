import { WebClient } from '@app/web-client/WebClient';

export abstract class WebClientService {
  abstract create(url?: string): WebClient;
}
