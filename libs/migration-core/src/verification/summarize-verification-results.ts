import { ARTIFACT_TYPES, type ArtifactType, type VerificationResult } from './types.js';

export interface TierCounts {
  readonly total: number;
  readonly medium: number;
  readonly low: number;
  readonly rejected: number;
}

/**
 * CLAUDE.md's reporting-honesty rule, made concrete: every artifact type
 * is present in the output even at zero, so a caller can't silently drop
 * a category that happened to have no results this run — the same
 * "never omit, always report the messiest bucket too" discipline M1's
 * own per-repo hit-count reporting used throughout.
 */
export function summarizeByArtifactType(
  results: readonly VerificationResult[]
): Record<ArtifactType, TierCounts> {
  const summary = Object.fromEntries(
    ARTIFACT_TYPES.map((type) => [type, { total: 0, medium: 0, low: 0, rejected: 0 }])
  ) as Record<ArtifactType, TierCounts>;

  for (const result of results) {
    const bucket = summary[result.artifactType];
    summary[result.artifactType] = {
      total: bucket.total + 1,
      medium: bucket.medium + (result.tier === 'MEDIUM' ? 1 : 0),
      low: bucket.low + (result.tier === 'LOW' ? 1 : 0),
      rejected: bucket.rejected + (result.tier === 'REJECTED' ? 1 : 0),
    };
  }

  return summary;
}
