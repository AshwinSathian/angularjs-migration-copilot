import { describe, expect, it } from 'vitest';
import { redact, scanForSecrets } from './scan.js';

describe('scanForSecrets', () => {
  it('finds nothing in ordinary AngularJS source', () => {
    const source = `
      angular.module('app').controller('MainCtrl', ['$scope', '$http', function ($scope, $http) {
        $scope.items = [];
        $http.get('/api/items').then(function (res) { $scope.items = res.data; });
      }]);
    `;
    const result = scanForSecrets(source);
    expect(result.hasSecrets).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it('detects an AWS access key ID', () => {
    const result = scanForSecrets('const key = "AKIAABCDEFGHIJKLMNOP";');
    expect(result.hasSecrets).toBe(true);
    expect(result.findings[0]?.patternId).toBe('aws-access-key-id');
  });

  it('detects a PEM private key block spanning multiple lines', () => {
    const source = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA1234567890abcdef',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = scanForSecrets(source);
    expect(result.findings.map((f) => f.patternId)).toContain('private-key-block');
  });

  it('detects a GitHub token', () => {
    const result = scanForSecrets(
      'GITHUB_TOKEN=ghp_1234567890abcdef1234567890abcdef1234'
    );
    expect(result.findings.map((f) => f.patternId)).toContain('github-token');
  });

  it('detects a database connection string with embedded credentials', () => {
    const result = scanForSecrets(
      "const uri = 'mongodb+srv://user:sup3rSecret@cluster0.mongodb.net/db';"
    );
    expect(result.findings.map((f) => f.patternId)).toContain('connection-string');
  });

  it('detects a generic apiKey assignment', () => {
    const result = scanForSecrets('const config = { apiKey: "sk-abcdef0123456789" };');
    expect(result.findings.map((f) => f.patternId)).toContain(
      'generic-api-key-assignment'
    );
  });

  it('detects an .env-style secret line', () => {
    const result = scanForSecrets('DATABASE_PASSWORD=hunter2hunter2hunter2');
    expect(result.findings.map((f) => f.patternId)).toContain('env-style-secret-line');
  });

  it('reports a masked preview, never the raw secret', () => {
    const result = scanForSecrets('const key = "AKIAABCDEFGHIJKLMNOP";');
    expect(result.findings[0]?.redactedPreview).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(result.findings[0]?.redactedPreview).toMatch(/^AKIA\*+MNOP$/);
  });

  it('reports the correct line number for a match past the first line', () => {
    const source = 'line one\nline two\nconst key = "AKIAABCDEFGHIJKLMNOP";';
    const result = scanForSecrets(source);
    expect(result.findings[0]?.line).toBe(3);
  });

  it('reports one finding, not two, when a quoted KEY=value line matches two patterns', () => {
    // 'API_KEY="..."' matches generic-api-key-assignment (the quoted value)
    // AND env-style-secret-line (the whole KEY=value line) — these are the
    // same real secret found by two independently-reasonable patterns, not
    // two secrets. Whichever pattern is earlier in SECRET_PATTERNS wins;
    // the point of this test is exactly-one, not which one.
    const result = scanForSecrets('API_KEY="abcdefghijklmnop1234"');
    expect(result.findings).toHaveLength(1);
  });
});

describe('redact', () => {
  it('blanks the secret but leaves surrounding code structure intact', () => {
    const source = 'const config = { apiKey: "sk-abcdef0123456789" };';
    const { redacted } = redact(source);
    expect(redacted).toBe(
      'const config = { apiKey: "[REDACTED:generic-api-key-assignment]" };'
    );
  });

  it('leaves content with no secrets completely unchanged', () => {
    const source = "$scope.name = 'hello world';";
    const { redacted, hasSecrets } = redact(source);
    expect(hasSecrets).toBe(false);
    expect(redacted).toBe(source);
  });

  it('redacts every occurrence, not just the first', () => {
    const source = [
      'AWS_KEY_1=AKIAABCDEFGHIJKLMNOP',
      'AWS_KEY_2=AKIAZYXWVUTSRQPONMLK',
    ].join('\n');
    const { redacted } = redact(source);
    expect(redacted).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(redacted).not.toContain('AKIAZYXWVUTSRQPONMLK');
  });

  it('is idempotent — redacting already-redacted content changes nothing further', () => {
    const source = 'const config = { apiKey: "sk-abcdef0123456789" };';
    const once = redact(source).redacted;
    const twice = redact(once).redacted;
    expect(twice).toBe(once);
  });

  it('redacts an overlapping double-pattern match exactly once', () => {
    // Same scenario as the scanForSecrets test above: without overlap
    // dedup, generic-api-key-assignment's replace pass redacts the value
    // first, then env-style-secret-line's pass matches the *already
    // redacted* placeholder text and redacts it a second time.
    const result = redact('API_KEY="abcdefghijklmnop1234"');
    expect(result.findings).toHaveLength(1);
    expect(result.redacted).toMatch(/^API_KEY="\[REDACTED:[a-z-]+\]"$/);
  });
});
