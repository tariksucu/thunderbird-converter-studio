import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_BASE_URL,
  loadSettings,
  normalizeBaseUrl,
  normalizeMaxCredits,
  originsFor,
} from '../src/lib/settings.js';

const storage = (values) => ({ get: async () => values });

describe('the API address', () => {
  it('accepts converter.studio over HTTPS, tidied', () => {
    assert.equal(normalizeBaseUrl('https://converter.studio/api/'), 'https://converter.studio/api');
    assert.equal(
      normalizeBaseUrl(' https://converter.studio/api '),
      'https://converter.studio/api',
    );
  });

  it('accepts a test server on this computer', () => {
    assert.equal(normalizeBaseUrl('http://localhost:8080/api'), 'http://localhost:8080/api');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/api/'), 'http://127.0.0.1:8080/api');
  });

  it('refuses every other address, so the key cannot be sent elsewhere', () => {
    for (const bad of [
      'http://converter.studio/api',
      'https://converter.studio.evil.example/api',
      'https://evil.example/api',
      'https://converter.studio:8443/api',
      'https://user:pass@converter.studio/api',
      'https://converter.studio/api?x=1',
      'ftp://localhost/api',
      'javascript:alert(1)',
      'not a url',
      '',
      undefined,
    ])
      assert.equal(normalizeBaseUrl(bad), null, String(bad));
  });

  it('asks for no extra permission for converter.studio, and both local names otherwise', () => {
    assert.deepEqual(originsFor(DEFAULT_BASE_URL), []);
    assert.deepEqual(originsFor('http://localhost:8080/api'), [
      'http://localhost/*',
      'http://127.0.0.1/*',
    ]);
    assert.deepEqual(originsFor('https://127.0.0.1:9/api'), [
      'https://localhost/*',
      'https://127.0.0.1/*',
    ]);
  });
});

describe('stored settings', () => {
  it('fill in the defaults', async () => {
    assert.deepEqual(await loadSettings(storage({})), {
      apiKey: '',
      baseUrl: 'https://converter.studio/api',
      maxCredits: 20,
      composeMode: 'replace',
    });
  });

  it('keep what was saved, and drop what is not allowed', async () => {
    assert.deepEqual(
      await loadSettings(
        storage({
          apiKey: ' cvs_live_x ',
          baseUrl: 'https://evil.example/api',
          maxCredits: 0,
          composeMode: 'add',
        }),
      ),
      {
        apiKey: 'cvs_live_x',
        baseUrl: 'https://converter.studio/api',
        maxCredits: 0,
        composeMode: 'add',
      },
    );
  });

  it('read a credit limit as a whole number from 0 to 100000', () => {
    assert.equal(normalizeMaxCredits('5'), 5);
    assert.equal(normalizeMaxCredits('0'), 0);
    assert.equal(normalizeMaxCredits(''), 20);
    assert.equal(normalizeMaxCredits('-1'), 20);
    assert.equal(normalizeMaxCredits('2.5'), 20);
    assert.equal(normalizeMaxCredits('100001'), 20);
  });
});
