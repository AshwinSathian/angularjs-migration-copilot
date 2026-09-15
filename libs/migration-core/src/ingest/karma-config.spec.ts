import { describe, expect, it } from 'vitest';
import { karmaConfigUsesPhantomJs, remediateKarmaConfig } from './karma-config.js';

describe('karmaConfigUsesPhantomJs', () => {
  it('detects PhantomJS in the browsers array', () => {
    expect(
      karmaConfigUsesPhantomJs("module.exports = function (c) { c.set({ browsers: ['PhantomJS'] }); };")
    ).toBe(true);
  });

  it('is false for a config already using a modern launcher', () => {
    expect(
      karmaConfigUsesPhantomJs(
        "module.exports = function (c) { c.set({ browsers: ['ChromeHeadless'] }); };"
      )
    ).toBe(false);
  });

  it('is false for a config with no browsers array at all', () => {
    expect(karmaConfigUsesPhantomJs('module.exports = function (c) { c.set({}); };')).toBe(false);
  });

  it('does not false-positive on a comment mentioning PhantomJS', () => {
    // The whole point of scoping this to the browsers array structurally,
    // not a whole-file substring match: a leftover comment or changelog
    // note about PhantomJS must not flag an already-fixed config.
    const config = [
      '// migrated off PhantomJS in 2023',
      'module.exports = function (c) { c.set({ browsers: ["ChromeHeadless"] }); };',
    ].join('\n');
    expect(karmaConfigUsesPhantomJs(config)).toBe(false);
  });

  it('does not false-positive on an unrelated identifier containing PhantomJS', () => {
    const config = [
      'var usePhantomJS = false;',
      'module.exports = function (c) { c.set({ browsers: ["ChromeHeadless"] }); };',
    ].join('\n');
    expect(karmaConfigUsesPhantomJs(config)).toBe(false);
  });

  it('does not false-positive on a customLaunchers entry referencing PhantomJS', () => {
    const config = `module.exports = function (c) { c.set({
      browsers: ['ChromeHeadless'],
      customLaunchers: { LegacyPhantom: { base: 'PhantomJS' } }
    }); };`;
    expect(karmaConfigUsesPhantomJs(config)).toBe(false);
  });
});

describe('remediateKarmaConfig', () => {
  it('swaps PhantomJS for ChromeHeadless in the browsers array, preserving quote style', () => {
    const result = remediateKarmaConfig(
      "module.exports = function (c) { c.set({ browsers: ['PhantomJS'] }); };"
    );
    expect(result).toEqual({
      changed: true,
      remediated: "module.exports = function (c) { c.set({ browsers: ['ChromeHeadless'] }); };",
    });
  });

  it('preserves double-quote style', () => {
    const result = remediateKarmaConfig(
      'module.exports = function (c) { c.set({ browsers: ["PhantomJS"] }); };'
    );
    expect(result.remediated).toBe(
      'module.exports = function (c) { c.set({ browsers: ["ChromeHeadless"] }); };'
    );
  });

  it('swaps every PhantomJS entry in a multi-browser array', () => {
    const result = remediateKarmaConfig(
      "c.set({ browsers: ['PhantomJS', 'Firefox'] });"
    );
    expect(result.remediated).toBe("c.set({ browsers: ['ChromeHeadless', 'Firefox'] });");
  });

  it('reports unchanged for a config that already uses a modern launcher', () => {
    const source = "c.set({ browsers: ['ChromeHeadless'] });";
    expect(remediateKarmaConfig(source)).toEqual({ changed: false, remediated: source });
  });

  it('leaves an unrelated identifier containing PhantomJS untouched', () => {
    // This is the exact bug a plain text/regex substitution had: renaming
    // a declaration but not its later reference (or vice versa) produces
    // broken JS. Being AST-scoped to the browsers array specifically means
    // this can't happen — nothing outside that array is ever touched.
    const source = [
      'var usePhantomJS = shouldUseLegacyLauncher();',
      "c.set({ browsers: ['PhantomJS'] });",
      'if (usePhantomJS) { setupLegacyStuff(); }',
    ].join('\n');
    const result = remediateKarmaConfig(source);
    expect(result.remediated).toContain('var usePhantomJS = shouldUseLegacyLauncher();');
    expect(result.remediated).toContain('if (usePhantomJS) { setupLegacyStuff(); }');
    expect(result.remediated).toContain("browsers: ['ChromeHeadless']");
  });

  it('leaves a customLaunchers entry referencing PhantomJS as a base untouched', () => {
    // Scoped remediation, on purpose: a custom launcher extending
    // PhantomJS needs more than a name swap (different required options),
    // so it's left alone rather than half-fixed into something broken.
    const source = `c.set({
      browsers: ['PhantomJS'],
      customLaunchers: { LegacyPhantom: { base: 'PhantomJS', flags: ['--no-sandbox'] } }
    });`;
    const result = remediateKarmaConfig(source);
    expect(result.remediated).toContain("browsers: ['ChromeHeadless']");
    expect(result.remediated).toContain("LegacyPhantom: { base: 'PhantomJS'");
  });

  it('leaves a comment mentioning PhantomJS untouched', () => {
    const source = "// PhantomJS is deprecated\nc.set({ browsers: ['ChromeHeadless'] });";
    const result = remediateKarmaConfig(source);
    expect(result).toEqual({ changed: false, remediated: source });
  });
});
