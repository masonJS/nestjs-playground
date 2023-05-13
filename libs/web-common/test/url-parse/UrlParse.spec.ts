import * as Url from 'url';
import fetch from 'node-fetch';

describe('UrlParse', () => {
  it('Url.Parse 메소드를 사용하면 정상적인 hostName을 가져오지 못한다.', () => {
    const hostName = 'hacker.com*.google.com';
    const requestUrl = `https://${hostName}`;

    const result = Url.parse(requestUrl);

    expect(result.hostname).toBe(hostName);
  });

  it('fetch를 사용하면 정상적인 hostName을 가져오지 못한다.', async () => {
    const hostName = 'hacker.com*.google.com';
    const requestUrl = `https://${hostName}`;

    await fetch(requestUrl);
  });
});
