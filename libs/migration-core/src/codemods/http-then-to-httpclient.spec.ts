import { describe, expect, it } from 'vitest';
import { assertCompiles } from './assert-compiles.js';
import { transformHttpThenToHttpClient } from './http-then-to-httpclient.js';
import type { CodemodResult } from './types.js';

function assertMatched(
  result: CodemodResult
): asserts result is { matched: true; output: string; warnings?: readonly string[] } {
  expect(result.matched).toBe(true);
  if (!result.matched) throw new Error('unreachable');
}

function assertUnmatched(result: CodemodResult): asserts result is { matched: false; reason: string } {
  expect(result.matched).toBe(false);
  if (result.matched) throw new Error('unreachable');
}

describe('transformHttpThenToHttpClient', () => {
  it("scaffolds a GET method for WeatherCtrl.js's real config-object shape (method/url bound through local vars)", () => {
    const before = [
      "angular.module('app').controller('WeatherCtrl', function ($scope, $http) {",
      "  var url = 'http://api.openweathermap.org/data/2.5/forecast';",
      "  var method = 'GET';",
      '  $scope.updateWeather = function () {',
      '    $http({',
      '      method: method, url: url, params: { appid: key },',
      '    }).then(function success(response) {',
      '      saveWeatherData(response.data);',
      '    }, function error() {',
      '      console.log("WEATHER FAILED");',
      '    });',
      '  };',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain("@Injectable({ providedIn: 'root' })");
    expect(result.output).toContain('class HttpMigrationService {');
    expect(result.output).toContain('constructor(private http: HttpClient) {}');
    expect(result.output).toContain('updateWeather(params?: Record<string, string | number | boolean>): Observable<unknown> {');
    expect(result.output).toContain("return this.http.get('http://api.openweathermap.org/data/2.5/forecast', { params });");
    // insert-only — the original call site and callback bodies are untouched
    expect(result.output).toContain('function success(response) {');
    expect(result.output).toContain('saveWeatherData(response.data);');
  });

  it("scaffolds a jsonp skip for WeatherCtrl.js's real named-function-declaration shape", () => {
    const before = [
      "angular.module('app').controller('WeatherCtrl', function ($scope, $http) {",
      '  function updateGeoData() {',
      "    $http.jsonp('http://www.geoplugin.net/json.gp?jsoncallback=JSON_CALLBACK').then(function success(response) {",
      '      $scope.geoData = response.data;',
      '    }, function error() {});',
      '  }',
      '  updateGeoData();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
    expect(result.reason).toContain('jsonp');
    expect(result.reason).toContain('HttpClientJsonpModule');
  });

  it('scaffolds a shorthand GET method with a plain literal URL and a named function-declaration enclosing name', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      '  function loadUsers() {',
      "    $http.get('/api/users').then(function (response) {",
      '      console.log(response.data);',
      '    });',
      '  }',
      '  loadUsers();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('loadUsers(): Observable<unknown> {');
    expect(result.output).toContain("return this.http.get('/api/users');");
  });

  it('scaffolds a body-bearing POST method with a params config detected in the trailing object literal', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      '  function saveUser() {',
      "    $http.post('/api/users', { name: 'x' }, { params: { dryRun: true } }).then(function () {});",
      '  }',
      '  saveUser();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('saveUser(body: unknown, params?: Record<string, string | number | boolean>): Observable<unknown> {');
    expect(result.output).toContain("return this.http.post('/api/users', body, { params });");
  });

  it('supports a two-link .then().catch() chain (depth 2)', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      '  function loadUsers() {',
      "    $http.get('/api/users').then(function () {}).catch(function () {});",
      '  }',
      '  loadUsers();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('loadUsers(): Observable<unknown> {');
  });

  it('skips a promise chain deeper than 2 links', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      '  function loadUsers() {',
      "    $http.get('/api/users').then(function () {}).then(function () {}).catch(function () {});",
      '  }',
      '  loadUsers();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
    expect(result.reason).toContain('3 links deep');
  });

  it('does not match a bare $http call with no .then()/.catch() chain', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      "  $http.get('/api/users');",
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
    expect(result.reason).toBe('no $http(...).then()/.catch() call (depth ≤ 2) found');
  });

  it('skips when the config-object method is not a plain string literal or a simple string-valued variable', () => {
    const before = [
      "angular.module('app').controller('A', function ($http, opts) {",
      '  function loadUsers() {',
      "    $http({ method: opts.method, url: '/api/users' }).then(function () {});",
      '  }',
      '  loadUsers();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
    expect(result.reason).toContain('method is not a plain string literal');
  });

  it('skips when no safe method name can be derived from the enclosing function', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      "  (function () { $http.get('/api/users').then(function () {}); })();",
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
    expect(result.reason).toContain('no safe method name');
  });

  it('surfaces a warning for a sibling call that is skipped, without dropping the successful one', () => {
    const before = [
      "angular.module('app').controller('A', function ($http, opts) {",
      '  function loadUsers() {',
      "    $http.get('/api/users').then(function () {});",
      '  }',
      '  function loadPosts() {',
      "    $http({ method: opts.method, url: '/api/posts' }).then(function () {});",
      '  }',
      '  loadUsers(); loadPosts();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('loadUsers(): Observable<unknown> {');
    expect(result.warnings?.some((w) => w.includes('method is not a plain string literal'))).toBe(true);
  });

  it('skips when two $http calls derive the same service method name', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      '  function loadUsers() {',
      "    $http.get('/api/users').then(function () {});",
      "    $http.get('/api/other-users').then(function () {});",
      '  }',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain("return this.http.get('/api/users');");
    expect(result.warnings?.some((w) => w.includes('derives the same service method name'))).toBe(true);
  });

  it('skips when the derived service class name collides with an existing top-level binding', () => {
    const before = [
      'class HttpMigrationService {}',
      "angular.module('app').controller('A', function ($http) {",
      '  function loadUsers() {',
      "    $http.get('/api/users').then(function () {});",
      '  }',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
    expect(result.reason).toContain('collides with an existing binding');
  });

  it('skips when a pre-existing import binding collides with a name the generated class references (HttpClient/Observable/Injectable)', () => {
    const before = [
      "import { HttpClient } from './my-custom-http';",
      "angular.module('app').controller('A', function ($http) {",
      '  function loadUsers() {',
      "    $http.get('/api/users').then(function () {});",
      '  }',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
    expect(result.reason).toContain('"HttpClient"');
  });

  it('inserts at true module top level, not nested inside the enclosing closure containing the matched call', () => {
    const before = [
      "angular.module('app').controller('A', function ($scope, $http) {",
      '  $scope.load = function () {',
      "    $http.get('/api/users').then(function () {});",
      '  };',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertMatched(result);
    assertCompiles(result.output);
    const classStart = result.output.indexOf('class HttpMigrationService');
    const loadStart = result.output.indexOf('$scope.load');
    expect(classStart).toBeGreaterThanOrEqual(0);
    expect(classStart).toBeLessThan(loadStart);
  });

  it('escapes a single quote in the URL so the emitted string literal does not break', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      '  function loadUsers() {',
      '    $http.get("/api/o\'brien").then(function () {});',
      '  }',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain("return this.http.get('/api/o\\'brien');");
  });

  it('skips a config-object method/url variable that is reassigned elsewhere in the file', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      "  var method = 'GET';",
      "  method = 'POST';",
      '  function loadUsers() {',
      "    $http({ method: method, url: '/api/users' }).then(function () {});",
      '  }',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
    expect(result.reason).toContain('method is not a plain string literal');
  });

  it('does not misread a POST body object literal as a params config when no third config argument is present', () => {
    // Found by adversarial review: `hasParamsConfig` originally checked
    // only the *last* argument's shape, so a 2-arg POST (url, body) whose
    // body object happened to contain a `params` key was misread as a
    // trailing config object, silently splitting real POST body data into
    // a separate caller-supplied `params` argument.
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      '  function saveUser() {',
      "    $http.post('/api/users', { params: 'x' }).then(function () {});",
      '  }',
      '  saveUser();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('saveUser(body: unknown): Observable<unknown> {');
    expect(result.output).toContain("return this.http.post('/api/users', body);");
  });

  it('does not require a body parameter for a real no-payload trigger POST', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      '  function triggerJob() {',
      "    $http.post('/api/trigger').then(function () {});",
      '  }',
      '  triggerJob();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('triggerJob(): Observable<unknown> {');
    expect(result.output).toContain("return this.http.post('/api/trigger', null);");
  });

  it('skips a method/url variable mutated via compound assignment (+=), not just plain =', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      "  var url = '/api/users';",
      "  url += '/extra';",
      '  function loadUsers() {',
      '    $http.get(url).then(function () {});',
      '  }',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
  });

  it('skips a derived method name that collides with the generated class\'s own "http" constructor parameter', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      "  function http() { $http.get('/api/users').then(function () {}); }",
      '  http();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
    expect(result.reason).toContain('http');
    expect(result.reason).toContain('constructor parameter');
  });

  it('skips a derived method name that collides with the reserved "constructor" member name', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      "  function constructor() { $http.get('/api/users').then(function () {}); }",
      '  constructor();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
    expect(result.reason).toContain('constructor');
  });

  it('does not add a body parameter for a config-object GET with a stray "data" key — GET has no body slot to pass it to', () => {
    // Found by adversarial review: an earlier version set hasBody from
    // the presence of `data` alone, regardless of verb, so a non-body
    // verb with a `data` key scaffolded a body parameter that was
    // declared but never actually passed to this.http.get(...) — silent
    // data loss for any caller supplying it.
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      '  function loadUsers() {',
      "    $http({ method: 'GET', url: '/api/x', data: { foo: 1 } }).then(function () {});",
      '  }',
      '  loadUsers();',
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('loadUsers(): Observable<unknown> {');
    expect(result.output).toContain("return this.http.get('/api/x');");
  });

  it('renders a config-object call\'s skip reason in config-object syntax, not shorthand', () => {
    const before = [
      "angular.module('app').controller('A', function ($http) {",
      "  (function () { $http({ method: 'get', url: '/api/posts' }).then(function () {}); })();",
      '});',
    ].join('\n');

    const result = transformHttpThenToHttpClient(before);

    assertUnmatched(result);
    expect(result.reason).toContain("$http({ method: 'get', url: '/api/posts' })");
    expect(result.reason).not.toContain('$http.get(');
  });
});
