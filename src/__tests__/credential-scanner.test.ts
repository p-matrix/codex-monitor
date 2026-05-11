// =============================================================================
// credential-scanner.test.ts — scanCredentials self-tests
//
// Coverage:
//   1. 16 built-in credential patterns — at least 1 detection case per pattern
//   2. TEST_EXCLUSIONS filter (example / placeholder / etc.)
//   3. Code block stripping (```/~~~/`...`)
//   4. Custom pattern injection
//   5. Multi-pattern + count accumulation
// =============================================================================

import { scanCredentials } from '../credential-scanner';

describe('scanCredentials — built-in patterns (16)', () => {

  test('OpenAI Project Key (sk-proj-)', () => {
    const r = scanCredentials('key: sk-proj-abcdefghijklmnopqrstu');
    expect(r.some((x) => x.name === 'OpenAI Project Key')).toBe(true);
  });

  test('OpenAI Legacy Key (sk-...) — not sk-proj/ant/test/fake', () => {
    const r = scanCredentials('key: sk-abcdefghijklmnopqrstuvwxyz12');
    expect(r.some((x) => x.name === 'OpenAI Legacy Key')).toBe(true);
  });

  test('Anthropic Key (sk-ant-)', () => {
    const text = 'sk-ant-' + 'a'.repeat(40);
    expect(scanCredentials(text).some((x) => x.name === 'Anthropic Key')).toBe(true);
  });

  test('AWS Access Key (AKIA...)', () => {
    // 16 uppercase / digit chars after AKIA, avoiding TEST_EXCLUSIONS filter words
    expect(scanCredentials('AKIAQRSTUVWXYZ123456').some((x) => x.name === 'AWS Access Key'))
      .toBe(true);
  });

  test('GitHub Token (ghp_)', () => {
    const text = 'ghp_' + 'a'.repeat(36);
    expect(scanCredentials(text).some((x) => x.name === 'GitHub Token')).toBe(true);
  });

  test('GitHub Fine-grained Token (github_pat_)', () => {
    const text = 'github_pat_' + 'a'.repeat(82);
    expect(scanCredentials(text).some((x) => x.name === 'GitHub Fine-grained Token')).toBe(true);
  });

  test('Private Key (PEM) — RSA / EC / OPENSSH variants', () => {
    expect(scanCredentials('-----BEGIN RSA PRIVATE KEY-----')
      .some((x) => x.name === 'Private Key (PEM)')).toBe(true);
    expect(scanCredentials('-----BEGIN EC PRIVATE KEY-----')
      .some((x) => x.name === 'Private Key (PEM)')).toBe(true);
    expect(scanCredentials('-----BEGIN OPENSSH PRIVATE KEY-----')
      .some((x) => x.name === 'Private Key (PEM)')).toBe(true);
  });

  test('Database URL (postgresql://)', () => {
    expect(scanCredentials('postgresql://u:p@host/db')
      .some((x) => x.name === 'Database URL')).toBe(true);
  });

  test('Database URL (mysql://)', () => {
    expect(scanCredentials('mysql://root:secret@localhost/app')
      .some((x) => x.name === 'Database URL')).toBe(true);
  });

  test('Password in Context', () => {
    expect(scanCredentials('password: supersecret123')
      .some((x) => x.name === 'Password in Context')).toBe(true);
  });

  test('Bearer Token', () => {
    const text = 'Authorization: Bearer ' + 'a'.repeat(20);
    expect(scanCredentials(text).some((x) => x.name === 'Bearer Token')).toBe(true);
  });

  test('Google AI Key (AIza...)', () => {
    const text = 'AIza' + 'a'.repeat(35);
    expect(scanCredentials(text).some((x) => x.name === 'Google AI Key')).toBe(true);
  });

  test('Stripe Secret Key (sk_live_...)', () => {
    expect(scanCredentials('sk_live_' + 'a'.repeat(24))
      .some((x) => x.name === 'Stripe Secret Key')).toBe(true);
  });

  test('Slack Token (xoxb-...)', () => {
    expect(scanCredentials('xoxb-1234567890-abc')
      .some((x) => x.name === 'Slack Token')).toBe(true);
  });

  test('npm Token (npm_)', () => {
    const text = 'npm_' + 'a'.repeat(36);
    expect(scanCredentials(text).some((x) => x.name === 'npm Token')).toBe(true);
  });

  test('SendGrid Key (SG....)', () => {
    const text = 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(22);
    expect(scanCredentials(text).some((x) => x.name === 'SendGrid Key')).toBe(true);
  });

  test('Discord Bot Token', () => {
    const text = 'M' + 'a'.repeat(23) + '.aaaaaa.' + 'b'.repeat(27);
    expect(scanCredentials(text).some((x) => x.name === 'Discord Bot Token')).toBe(true);
  });
});

// ── TEST_EXCLUSIONS filter ────────────────────────────────────────────────────

describe('TEST_EXCLUSIONS filter', () => {
  test('"example" → skipped', () => {
    expect(scanCredentials('sk-proj-exampleabcdefghijklmnopqr')).toEqual([]);
  });

  test('"placeholder" → skipped', () => {
    const text = 'Bearer placeholder-token-here-now-extra-bytes';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('"INSERT_" → skipped', () => {
    expect(scanCredentials('Bearer INSERT_YOUR_TOKEN_HERE_NOW_EXTRA')).toEqual([]);
  });
});

// ── Code block stripping ──────────────────────────────────────────────────────

describe('code block stripping', () => {
  test('fenced ``` strips contained credentials', () => {
    const text = '```\nsk-proj-abcdefghijklmnopqrstu\n```';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('inline backtick `...` strips contained credentials', () => {
    const text = '`AKIAIAAAABBBBBBBBBBB` is example';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('credentials outside code blocks still detected', () => {
    const text = '```\nFAKE = "AKIAIAAAABBBBBBBBBBB"\n```\nReal: AKIAIAAAABBBBBBBBBBB';
    const r = scanCredentials(text);
    const aws = r.find((x) => x.name === 'AWS Access Key');
    expect(aws).toBeDefined();
    expect(aws!.count).toBe(1);
  });
});

// ── Custom patterns ───────────────────────────────────────────────────────────

describe('custom patterns', () => {
  test('valid custom regex detected', () => {
    const r = scanCredentials('CO-SECRET-abc123', ['CO-SECRET-[a-z0-9]+']);
    expect(r.some((x) => x.name === 'Custom Pattern')).toBe(true);
  });

  test('invalid regex silently ignored', () => {
    expect(() => scanCredentials('text', ['[bad('])).not.toThrow();
    expect(scanCredentials('text', ['[bad('])).toEqual([]);
  });
});

// ── Multi-pattern + count ─────────────────────────────────────────────────────

describe('multi-pattern + count', () => {
  test('two distinct patterns → both reported', () => {
    const text = [
      'AWS_ACCESS_KEY_ID=AKIAIAAAABBBBBBBBBBB',
      'GH=ghp_' + 'a'.repeat(36),
    ].join('\n');
    const r = scanCredentials(text);
    expect(r.some((x) => x.name === 'AWS Access Key')).toBe(true);
    expect(r.some((x) => x.name === 'GitHub Token')).toBe(true);
  });

  test('same pattern twice → count: 2', () => {
    const text = 'k1: AKIAIAAAABBBBBBBBBBB k2: AKIABBBBAAAAAAAAAAAA';
    const r = scanCredentials(text);
    const aws = r.find((x) => x.name === 'AWS Access Key');
    expect(aws!.count).toBe(2);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  test('empty input → []', () => expect(scanCredentials('')).toEqual([]));
  test('clean text → []', () =>
    expect(scanCredentials('Hello, this is harmless text.')).toEqual([]));
});
