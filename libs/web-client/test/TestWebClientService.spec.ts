import { WebClientService } from '@app/web-client/WebClientService';
import { TestWebClientService } from './TestWebClientService';
import { StubWebClient } from './StubWebClient';

export class ADto {
  name: string;
}

export class AService {
  constructor(private readonly webClientService: WebClientService) {}

  async getName(url: string) {
    return await this.webClientService
      .create()
      .get()
      .url(url)
      .retrieve()
      .then((response) => response.toEntity(ADto));
  }
}

describe('TestWebClientService', () => {
  let aService: AService;
  const stubWebClient = StubWebClient.getInstance();

  beforeAll(() => {
    aService = new AService(new TestWebClientService());
  });

  beforeEach(() => stubWebClient.clear());

  describe('getName', () => {
    it('이름을 조회한다.', async () => {
      // given
      const url = 'http://www.example.com';
      stubWebClient.url(url).get().addResponse({ name: 'haru' });

      // when
      const response = await aService.getName(url);

      // then
      expect(response.name).toBe('haru');
    });

    it('조회시 오류가 발생한다.', async () => {
      // given
      const url = 'http://www.example.com';
      stubWebClient.url(url).get().addError('error response', 400);

      // when
      const response = async () => aService.getName(url);

      // then
      await expect(response).rejects.toThrow('error response');
    });
  });
});
