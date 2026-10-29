import { describe, expect, it } from 'vitest';
import { classifyPushFailure, describeUserAgent, isAllowedPushEndpoint } from './push-endpoint';

describe('isAllowedPushEndpoint', () => {
  it('accepts the push services real browsers use', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc:APA91b')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/gAAA')).toBe(true);
    expect(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/QGx')).toBe(true);
  });

  it('refuses anything that would turn delivery into SSRF', () => {
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isAllowedPushEndpoint('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedPushEndpoint('https://localhost/fcm/send')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com:8443/fcm/send')).toBe(false);
    expect(isAllowedPushEndpoint('https://user:pw@fcm.googleapis.com/fcm/send')).toBe(false);
    expect(isAllowedPushEndpoint('not a url')).toBe(false);
  });

  it('does not let a lookalike host through a suffix or prefix match', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://evilfcm.googleapis.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://notify.windows.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://evilnotify.windows.com/x')).toBe(false);
  });
});

describe('classifyPushFailure', () => {
  it('drops subscriptions the push service says are gone', () => {
    expect(classifyPushFailure(404)).toBe('GONE');
    expect(classifyPushFailure(410)).toBe('GONE');
  });

  it('retries everything else', () => {
    expect(classifyPushFailure(429)).toBe('RETRY');
    expect(classifyPushFailure(500)).toBe('RETRY');
    expect(classifyPushFailure(undefined)).toBe('RETRY');
  });
});

describe('describeUserAgent', () => {
  it('names the browser and platform', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36',
      ),
    ).toBe('Samsung Internet on Android');
    expect(describeUserAgent(null)).toBe('Unknown device');
  });
});
