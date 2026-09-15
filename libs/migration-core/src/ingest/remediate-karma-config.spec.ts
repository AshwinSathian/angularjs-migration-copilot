import { describe, expect, it } from 'vitest';
import { remediateKarmaConfig } from './remediate-karma-config.js';

describe('remediateKarmaConfig', () => {
  it('swaps a single-quoted PhantomJS browser entry for ChromeHeadless', () => {
    const result = remediateKarmaConfig("config.set({ browsers: ['PhantomJS'] });");
    expect(result).toEqual({
      changed: true,
      remediated: "config.set({ browsers: ['ChromeHeadless'] });",
    });
  });

  it('swaps a double-quoted PhantomJS browser entry for ChromeHeadless', () => {
    const result = remediateKarmaConfig('config.set({ browsers: ["PhantomJS"] });');
    expect(result.remediated).toBe('config.set({ browsers: ["ChromeHeadless"] });');
  });

  it('swaps every PhantomJS occurrence, not just the first', () => {
    const source = "browsers: ['PhantomJS'],\nsingleRun: true, // was PhantomJS before";
    const result = remediateKarmaConfig(source);
    expect(result.remediated).not.toContain('PhantomJS');
    expect(result.remediated).toContain('ChromeHeadless');
  });

  it('reports unchanged for a config that already uses a modern launcher', () => {
    const source = "config.set({ browsers: ['ChromeHeadless'] });";
    expect(remediateKarmaConfig(source)).toEqual({ changed: false, remediated: source });
  });

  it('does not falsely match "karma-phantomjs-launcher" as a browsers-array entry', () => {
    const source = "plugins: ['karma-phantomjs-launcher'], browsers: ['PhantomJS']";
    const result = remediateKarmaConfig(source);
    // The require/plugin string is a different, lowercase token and is left
    // alone; only the exact "PhantomJS" browser identifier gets swapped.
    expect(result.remediated).toContain("'karma-phantomjs-launcher'");
    expect(result.remediated).toContain("browsers: ['ChromeHeadless']");
  });
});
