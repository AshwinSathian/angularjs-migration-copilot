import { describe, expect, it } from 'vitest';
import { summarizeByArtifactType } from './summarize-verification-results.js';
import type { VerificationResult } from './types.js';

describe('summarizeByArtifactType', () => {
  it('buckets counts per artifact type, never a single blended total', () => {
    const results: VerificationResult[] = [
      { tier: 'LOW', artifactType: 'controller', reason: 'no characterization target', compileLog: '' },
      { tier: 'REJECTED', artifactType: 'controller', failedCheck: 'compile', reason: 'x', compileLog: '' },
      { tier: 'MEDIUM', artifactType: 'service', compileLog: '', characterization: { eligible: true, matched: true, casesRun: 3 } },
    ];

    const summary = summarizeByArtifactType(results);

    expect(summary.controller).toEqual({ total: 2, medium: 0, low: 1, rejected: 1 });
    expect(summary.service).toEqual({ total: 1, medium: 1, low: 0, rejected: 0 });
    expect(summary.filter).toEqual({ total: 0, medium: 0, low: 0, rejected: 0 });
    expect(summary.directive).toEqual({ total: 0, medium: 0, low: 0, rejected: 0 });
  });

  it('every artifact type is present even with zero results — no silently-omitted category', () => {
    const summary = summarizeByArtifactType([]);
    expect(Object.keys(summary).sort()).toEqual(['controller', 'directive', 'filter', 'service']);
  });
});
