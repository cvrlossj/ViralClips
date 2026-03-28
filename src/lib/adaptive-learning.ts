import fs from "node:fs/promises";
import path from "node:path";
import { benchmarksDir } from "@/lib/paths";

type ClipOverallWeights = {
  hook: number;
  flow: number;
  engagement: number;
  completeness: number;
};

type BeatCoverageWeights = {
  hook: number;
  setup: number;
  buildup: number;
  payoff: number;
  reaction: number;
};

type NarrativeBlendWeights = {
  completeness: number;
  beatCoverage: number;
  flow: number;
  hook: number;
};

type EngagementBlendWeights = {
  momentEngagement: number;
  climax: number;
  hook: number;
};

type MergeMetricWeights = {
  base: number;
  beat: number;
};

type VariantNarrativeWeights = {
  narrative: number;
  completeness: number;
  beatCoverage: number;
  flow: number;
};

type VariantEngagementWeights = {
  beatEngagement: number;
  beatHook: number;
  momentEngagement: number;
};

type QualityGateBlendWeights = {
  completeness: number;
  narrative: number;
  engagement: number;
  hook: number;
};

type QualityGateThresholds = {
  hook: number;
  completeness: number;
  narrative: number;
  engagement: number;
};

export type AdaptiveScoringProfile = {
  version: 1;
  source: "default" | "learned";
  updatedAt: string;
  sampleCount: number;
  platformCount: number;
  signals: {
    shortShare: number;
    midShare: number;
    longShare: number;
    engagementNorm: number;
    growthNorm: number;
  };
  weights: {
    clipOverall: ClipOverallWeights;
    beatCoverage: BeatCoverageWeights;
    narrativeBlend: NarrativeBlendWeights;
    engagementBlend: EngagementBlendWeights;
    mergeClipScores: {
      hook: MergeMetricWeights;
      flow: MergeMetricWeights;
      engagement: MergeMetricWeights;
      completeness: MergeMetricWeights;
    };
    variant: {
      narrative: VariantNarrativeWeights;
      engagement: VariantEngagementWeights;
      overall: { narrative: number; engagement: number };
      kindBias: { safe: number; balanced: number; aggressive: number };
      flatPenalty: number;
    };
    qualityGate: {
      thresholds: QualityGateThresholds;
      blend: QualityGateBlendWeights;
      issuePenalty: number;
      passMinScore: number;
    };
    antiFlat: {
      hookFloor: number;
      completenessFloor: number;
      flatRiskHook: number;
      flatRiskCompleteness: number;
      flatRiskMissingBeats: number;
    };
  };
};

export type AdaptiveVideoSample = {
  views: number;
  durationSeconds: number;
  engagementRate?: number;
};

export type AdaptivePlatformTrainingInput = {
  platform: string;
  status?: string;
  topVideos: AdaptiveVideoSample[];
  timeline?: Array<{
    date: string;
    views: number;
    videos: number;
  }>;
};

export type AdaptiveLearningResult = {
  updated: boolean;
  reason: "disabled" | "not-enough-samples" | "rate-limited" | "updated";
  profile: AdaptiveScoringProfile;
  sampleCount: number;
  platformCount: number;
};

const PROFILE_FILE = path.join(benchmarksDir, "adaptive-scoring.json");
const ZERO_TIME_ISO = "1970-01-01T00:00:00.000Z";

const DEFAULT_PROFILE: AdaptiveScoringProfile = {
  version: 1,
  source: "default",
  updatedAt: ZERO_TIME_ISO,
  sampleCount: 0,
  platformCount: 0,
  signals: {
    shortShare: 0.35,
    midShare: 0.45,
    longShare: 0.2,
    engagementNorm: 0.5,
    growthNorm: 0.5,
  },
  weights: {
    clipOverall: {
      hook: 0.35,
      flow: 0.2,
      engagement: 0.3,
      completeness: 0.15,
    },
    beatCoverage: {
      hook: 0.18,
      setup: 0.2,
      buildup: 0.22,
      payoff: 0.24,
      reaction: 0.16,
    },
    narrativeBlend: {
      completeness: 0.42,
      beatCoverage: 0.26,
      flow: 0.16,
      hook: 0.16,
    },
    engagementBlend: {
      momentEngagement: 0.55,
      climax: 0.3,
      hook: 0.15,
    },
    mergeClipScores: {
      hook: { base: 0.35, beat: 0.65 },
      flow: { base: 0.45, beat: 0.55 },
      engagement: { base: 0.4, beat: 0.6 },
      completeness: { base: 0.25, beat: 0.75 },
    },
    variant: {
      narrative: {
        narrative: 0.48,
        completeness: 0.24,
        beatCoverage: 0.16,
        flow: 0.12,
      },
      engagement: {
        beatEngagement: 0.58,
        beatHook: 0.22,
        momentEngagement: 0.2,
      },
      overall: {
        narrative: 0.58,
        engagement: 0.42,
      },
      kindBias: {
        safe: 1,
        balanced: 0,
        aggressive: 2,
      },
      flatPenalty: 18,
    },
    qualityGate: {
      thresholds: {
        hook: 38,
        completeness: 62,
        narrative: 62,
        engagement: 58,
      },
      blend: {
        completeness: 0.34,
        narrative: 0.32,
        engagement: 0.2,
        hook: 0.14,
      },
      issuePenalty: 9,
      passMinScore: 60,
    },
    antiFlat: {
      hookFloor: 35,
      completenessFloor: 62,
      flatRiskHook: 40,
      flatRiskCompleteness: 58,
      flatRiskMissingBeats: 2,
    },
  },
};

let inMemoryProfile: AdaptiveScoringProfile | null = null;

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundWeight(value: number): number {
  return Number(value.toFixed(4));
}

function asNumber(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function readNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

function normalizeWithFloor<T extends string>(
  values: Record<T, number>,
  floors: Record<T, number>,
): Record<T, number> {
  const keys = Object.keys(values) as T[];
  if (keys.length === 0) return values;

  const floorSum = keys.reduce((acc, key) => acc + floors[key], 0);
  if (floorSum >= 0.9999) {
    const equal = 1 / keys.length;
    const fallback = {} as Record<T, number>;
    for (const key of keys) {
      fallback[key] = roundWeight(equal);
    }
    fallback[keys[0]] = roundWeight(fallback[keys[0]] + (1 - keys.reduce((acc, key) => acc + fallback[key], 0)));
    return fallback;
  }

  const extras = {} as Record<T, number>;
  let extrasSum = 0;
  for (const key of keys) {
    const safeValue = Math.max(0, asNumber(values[key], 0));
    const extra = Math.max(0, safeValue - floors[key]);
    extras[key] = extra;
    extrasSum += extra;
  }

  const targetExtra = Math.max(0, 1 - floorSum);
  const normalized = {} as Record<T, number>;

  if (extrasSum <= 0) {
    const spread = targetExtra / keys.length;
    for (const key of keys) {
      normalized[key] = roundWeight(floors[key] + spread);
    }
  } else {
    for (const key of keys) {
      normalized[key] = roundWeight(floors[key] + (extras[key] / extrasSum) * targetExtra);
    }
  }

  const total = keys.reduce((acc, key) => acc + normalized[key], 0);
  normalized[keys[0]] = roundWeight(normalized[keys[0]] + (1 - total));
  return normalized;
}

function blendNumber(previous: number, next: number, alpha: number): number {
  return previous * (1 - alpha) + next * alpha;
}

function blendMap<T extends string>(
  previous: Record<T, number>,
  next: Record<T, number>,
  alpha: number,
  floors: Record<T, number>,
): Record<T, number> {
  const keys = Object.keys(previous) as T[];
  const raw = {} as Record<T, number>;
  for (const key of keys) {
    raw[key] = blendNumber(previous[key], next[key], alpha);
  }
  return normalizeWithFloor(raw, floors);
}

function normalizePair(base: number, beat: number, baseMin: number, beatMin: number): MergeMetricWeights {
  const safeBase = Math.max(baseMin, base);
  const safeBeat = Math.max(beatMin, beat);
  const sum = safeBase + safeBeat;
  if (sum <= 0) {
    return { base: 0.5, beat: 0.5 };
  }
  const normalizedBase = roundWeight(safeBase / sum);
  const normalizedBeat = roundWeight(1 - normalizedBase);
  return { base: normalizedBase, beat: normalizedBeat };
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function parseIsoDate(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type PlatformFeatures = {
  platform: string;
  sampleCount: number;
  totalViews: number;
  shortShare: number;
  midShare: number;
  longShare: number;
  engagementNorm: number;
  growthNorm: number;
  importance: number;
};

function computeGrowthNorm(
  timeline: Array<{ date: string; views: number; videos: number }> | undefined,
): number {
  if (!timeline || timeline.length < 2) return 0.5;
  const rows = [...timeline]
    .filter((row) => row.views > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 2) return 0.5;

  const split = Math.max(1, Math.floor(rows.length / 2));
  const left = rows.slice(0, split);
  const right = rows.slice(split);
  if (right.length === 0) return 0.5;

  const avgLeft = left.reduce((acc, row) => acc + row.views, 0) / left.length;
  const avgRight = right.reduce((acc, row) => acc + row.views, 0) / right.length;
  if (avgLeft <= 0 && avgRight <= 0) return 0.5;
  const growth = (avgRight - avgLeft) / Math.max(1, avgLeft);
  return clamp((growth + 1) / 2, 0, 1);
}

function computePlatformFeatures(input: AdaptivePlatformTrainingInput): PlatformFeatures | null {
  const samples = input.topVideos.filter((video) => video.views > 0 && video.durationSeconds > 0);
  if (samples.length === 0) return null;

  const sampleWeights = samples.map((video) => Math.sqrt(Math.max(1, video.views)));
  const weightSum = sampleWeights.reduce((acc, value) => acc + value, 0);
  if (weightSum <= 0) return null;

  let shortScore = 0;
  let midScore = 0;
  let longScore = 0;
  let totalViews = 0;

  let engagementWeighted = 0;
  let engagementWeight = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const video = samples[i];
    const weight = sampleWeights[i];
    totalViews += video.views;

    if (video.durationSeconds <= 35) {
      shortScore += weight;
    } else if (video.durationSeconds <= 65) {
      midScore += weight;
    } else {
      longScore += weight;
    }

    if (Number.isFinite(video.engagementRate) && (video.engagementRate ?? 0) > 0) {
      engagementWeighted += (video.engagementRate ?? 0) * weight;
      engagementWeight += weight;
    }
  }

  const shortShare = shortScore / weightSum;
  const midShare = midScore / weightSum;
  const longShare = longScore / weightSum;
  const rawEngagement = engagementWeight > 0 ? engagementWeighted / engagementWeight : 0.06;
  const engagementNorm = clamp(rawEngagement / 0.12, 0, 1);
  const growthNorm = computeGrowthNorm(input.timeline);
  const importance =
    Math.log10(totalViews + 10) +
    clamp(samples.length / 8, 0, 1.5) +
    (engagementWeight > 0 ? 0.4 : 0);

  return {
    platform: input.platform,
    sampleCount: samples.length,
    totalViews,
    shortShare,
    midShare,
    longShare,
    engagementNorm,
    growthNorm,
    importance,
  };
}

function buildLearnedCandidate(features: PlatformFeatures[]): AdaptiveScoringProfile {
  const totalImportance = features.reduce((acc, feature) => acc + feature.importance, 0);
  const safeImportance = Math.max(totalImportance, 0.0001);

  const signal = {
    shortShare: features.reduce((acc, feature) => acc + feature.shortShare * feature.importance, 0) / safeImportance,
    midShare: features.reduce((acc, feature) => acc + feature.midShare * feature.importance, 0) / safeImportance,
    longShare: features.reduce((acc, feature) => acc + feature.longShare * feature.importance, 0) / safeImportance,
    engagementNorm:
      features.reduce((acc, feature) => acc + feature.engagementNorm * feature.importance, 0) / safeImportance,
    growthNorm: features.reduce((acc, feature) => acc + feature.growthNorm * feature.importance, 0) / safeImportance,
  };

  const shortBias = clamp(signal.shortShare - signal.longShare, -0.7, 0.7);
  const longBias = clamp(signal.longShare - signal.shortShare, -0.7, 0.7);
  const midBias = clamp(signal.midShare - 0.35, -0.35, 0.35);
  const engagementBias = clamp(signal.engagementNorm - 0.5, -0.5, 0.5);
  const growthBias = clamp(signal.growthNorm - 0.5, -0.5, 0.5);

  const clipOverall = normalizeWithFloor(
    {
      hook: 0.35 + shortBias * 0.09 + engagementBias * 0.04 + growthBias * 0.02 - longBias * 0.03,
      flow: 0.2 + longBias * 0.06 + midBias * 0.03 - shortBias * 0.03 + growthBias * 0.01,
      engagement: 0.3 + engagementBias * 0.1 + shortBias * 0.05 + growthBias * 0.02,
      completeness: 0.15 + longBias * 0.08 + midBias * 0.04 - shortBias * 0.04,
    },
    {
      hook: 0.2,
      flow: 0.14,
      engagement: 0.2,
      completeness: 0.1,
    },
  );

  const beatCoverage = normalizeWithFloor(
    {
      hook: 0.18 + shortBias * 0.06 + engagementBias * 0.02 - longBias * 0.03,
      setup: 0.2 + longBias * 0.03 - shortBias * 0.02,
      buildup: 0.22 + longBias * 0.04 - shortBias * 0.02,
      payoff: 0.24 + longBias * 0.03 - shortBias * 0.01,
      reaction: 0.16 + engagementBias * 0.03 + longBias * 0.01,
    },
    {
      hook: 0.1,
      setup: 0.1,
      buildup: 0.1,
      payoff: 0.12,
      reaction: 0.1,
    },
  );

  const narrativeBlend = normalizeWithFloor(
    {
      completeness: 0.42 + longBias * 0.05 + midBias * 0.02,
      beatCoverage: 0.26 + longBias * 0.04 + growthBias * 0.02,
      flow: 0.16 + longBias * 0.02 + midBias * 0.02,
      hook: 0.16 + shortBias * 0.05 + engagementBias * 0.02 - longBias * 0.03,
    },
    {
      completeness: 0.24,
      beatCoverage: 0.16,
      flow: 0.1,
      hook: 0.1,
    },
  );

  const engagementBlend = normalizeWithFloor(
    {
      momentEngagement: 0.55 + engagementBias * 0.07,
      climax: 0.3 + longBias * 0.04 + midBias * 0.02,
      hook: 0.15 + shortBias * 0.05 + engagementBias * 0.02,
    },
    {
      momentEngagement: 0.35,
      climax: 0.2,
      hook: 0.1,
    },
  );

  const variantNarrative = normalizeWithFloor(
    {
      narrative: 0.48 + longBias * 0.04 + growthBias * 0.01,
      completeness: 0.24 + longBias * 0.03 + midBias * 0.02,
      beatCoverage: 0.16 + longBias * 0.02,
      flow: 0.12 + midBias * 0.02 + growthBias * 0.02,
    },
    {
      narrative: 0.32,
      completeness: 0.16,
      beatCoverage: 0.1,
      flow: 0.1,
    },
  );

  const variantEngagement = normalizeWithFloor(
    {
      beatEngagement: 0.58 + engagementBias * 0.08 + shortBias * 0.02,
      beatHook: 0.22 + shortBias * 0.05 + engagementBias * 0.02,
      momentEngagement: 0.2 + engagementBias * 0.03,
    },
    {
      beatEngagement: 0.34,
      beatHook: 0.14,
      momentEngagement: 0.12,
    },
  );

  const variantOverall = normalizeWithFloor(
    {
      narrative: 0.58 + longBias * 0.04 - shortBias * 0.02,
      engagement: 0.42 + shortBias * 0.03 + engagementBias * 0.03,
    },
    {
      narrative: 0.35,
      engagement: 0.35,
    },
  );

  const qualityGateBlend = normalizeWithFloor(
    {
      completeness: 0.34 + longBias * 0.03,
      narrative: 0.32 + longBias * 0.03 + growthBias * 0.02,
      engagement: 0.2 + engagementBias * 0.06 + shortBias * 0.02,
      hook: 0.14 + shortBias * 0.05 + engagementBias * 0.02,
    },
    {
      completeness: 0.2,
      narrative: 0.2,
      engagement: 0.14,
      hook: 0.1,
    },
  );

  const hookBeatRaw = clamp(0.65 + shortBias * 0.05 + engagementBias * 0.02, 0.45, 0.85);
  const flowBeatRaw = clamp(0.55 + longBias * 0.03 + growthBias * 0.02, 0.45, 0.8);
  const engagementBeatRaw = clamp(0.6 + engagementBias * 0.05 + shortBias * 0.02, 0.45, 0.82);
  const completenessBeatRaw = clamp(0.75 + longBias * 0.04, 0.55, 0.9);

  const sampleCount = features.reduce((acc, feature) => acc + feature.sampleCount, 0);
  const platformCount = features.length;

  return {
    version: 1,
    source: "learned",
    updatedAt: new Date().toISOString(),
    sampleCount,
    platformCount,
    signals: {
      shortShare: round2(signal.shortShare),
      midShare: round2(signal.midShare),
      longShare: round2(signal.longShare),
      engagementNorm: round2(signal.engagementNorm),
      growthNorm: round2(signal.growthNorm),
    },
    weights: {
      clipOverall,
      beatCoverage,
      narrativeBlend,
      engagementBlend,
      mergeClipScores: {
        hook: normalizePair(1 - hookBeatRaw, hookBeatRaw, 0.15, 0.35),
        flow: normalizePair(1 - flowBeatRaw, flowBeatRaw, 0.2, 0.35),
        engagement: normalizePair(1 - engagementBeatRaw, engagementBeatRaw, 0.18, 0.35),
        completeness: normalizePair(1 - completenessBeatRaw, completenessBeatRaw, 0.1, 0.45),
      },
      variant: {
        narrative: variantNarrative,
        engagement: variantEngagement,
        overall: variantOverall,
        kindBias: {
          safe: round2(1 + longBias * 0.5 - shortBias * 0.3),
          balanced: 0,
          aggressive: round2(2 + shortBias * 0.5 + engagementBias * 0.4),
        },
        flatPenalty: Math.round(clamp(18 + longBias * 2 - shortBias * 2, 12, 24)),
      },
      qualityGate: {
        thresholds: {
          hook: Math.round(clamp(38 + longBias * 2 - shortBias * 3 + growthBias, 30, 50)),
          completeness: Math.round(clamp(62 + longBias * 6 - shortBias * 4 + midBias * 2, 50, 80)),
          narrative: Math.round(clamp(62 + longBias * 5 - shortBias * 3 + growthBias * 2, 50, 80)),
          engagement: Math.round(clamp(58 + engagementBias * 10 + shortBias * 2, 45, 80)),
        },
        blend: qualityGateBlend,
        issuePenalty: Math.round(clamp(9 + (engagementBias < -0.2 ? 1 : 0) + (longBias > 0.2 ? 1 : 0), 7, 14)),
        passMinScore: Math.round(clamp(60 + longBias * 3 + engagementBias * 4 + growthBias * 2, 52, 78)),
      },
      antiFlat: {
        hookFloor: Math.round(clamp(35 + longBias * 2 - shortBias * 2, 28, 45)),
        completenessFloor: Math.round(clamp(62 + longBias * 4 - shortBias * 3, 50, 75)),
        flatRiskHook: Math.round(clamp(40 + longBias * 2 - shortBias * 2, 30, 52)),
        flatRiskCompleteness: Math.round(clamp(58 + longBias * 4 - shortBias * 3, 48, 72)),
        flatRiskMissingBeats: clamp(longBias > 0.2 ? 1 : shortBias > 0.25 ? 3 : 2, 1, 3),
      },
    },
  };
}

function blendProfiles(previous: AdaptiveScoringProfile, next: AdaptiveScoringProfile, alpha: number): AdaptiveScoringProfile {
  const safeAlpha = clamp(alpha, 0.05, 1);

  const clipOverall = blendMap(
    previous.weights.clipOverall,
    next.weights.clipOverall,
    safeAlpha,
    {
      hook: 0.2,
      flow: 0.14,
      engagement: 0.2,
      completeness: 0.1,
    },
  );

  const beatCoverage = blendMap(
    previous.weights.beatCoverage,
    next.weights.beatCoverage,
    safeAlpha,
    {
      hook: 0.1,
      setup: 0.1,
      buildup: 0.1,
      payoff: 0.12,
      reaction: 0.1,
    },
  );

  const narrativeBlend = blendMap(
    previous.weights.narrativeBlend,
    next.weights.narrativeBlend,
    safeAlpha,
    {
      completeness: 0.24,
      beatCoverage: 0.16,
      flow: 0.1,
      hook: 0.1,
    },
  );

  const engagementBlend = blendMap(
    previous.weights.engagementBlend,
    next.weights.engagementBlend,
    safeAlpha,
    {
      momentEngagement: 0.35,
      climax: 0.2,
      hook: 0.1,
    },
  );

  const qualityGateBlend = blendMap(
    previous.weights.qualityGate.blend,
    next.weights.qualityGate.blend,
    safeAlpha,
    {
      completeness: 0.2,
      narrative: 0.2,
      engagement: 0.14,
      hook: 0.1,
    },
  );

  const variantNarrative = blendMap(
    previous.weights.variant.narrative,
    next.weights.variant.narrative,
    safeAlpha,
    {
      narrative: 0.32,
      completeness: 0.16,
      beatCoverage: 0.1,
      flow: 0.1,
    },
  );

  const variantEngagement = blendMap(
    previous.weights.variant.engagement,
    next.weights.variant.engagement,
    safeAlpha,
    {
      beatEngagement: 0.34,
      beatHook: 0.14,
      momentEngagement: 0.12,
    },
  );

  const variantOverall = blendMap(
    previous.weights.variant.overall,
    next.weights.variant.overall,
    safeAlpha,
    {
      narrative: 0.35,
      engagement: 0.35,
    },
  );

  const hookMergeRaw = blendNumber(previous.weights.mergeClipScores.hook.beat, next.weights.mergeClipScores.hook.beat, safeAlpha);
  const flowMergeRaw = blendNumber(previous.weights.mergeClipScores.flow.beat, next.weights.mergeClipScores.flow.beat, safeAlpha);
  const engagementMergeRaw = blendNumber(
    previous.weights.mergeClipScores.engagement.beat,
    next.weights.mergeClipScores.engagement.beat,
    safeAlpha,
  );
  const completenessMergeRaw = blendNumber(
    previous.weights.mergeClipScores.completeness.beat,
    next.weights.mergeClipScores.completeness.beat,
    safeAlpha,
  );

  return {
    version: 1,
    source: "learned",
    updatedAt: new Date().toISOString(),
    sampleCount: next.sampleCount,
    platformCount: next.platformCount,
    signals: {
      shortShare: round2(blendNumber(previous.signals.shortShare, next.signals.shortShare, safeAlpha)),
      midShare: round2(blendNumber(previous.signals.midShare, next.signals.midShare, safeAlpha)),
      longShare: round2(blendNumber(previous.signals.longShare, next.signals.longShare, safeAlpha)),
      engagementNorm: round2(blendNumber(previous.signals.engagementNorm, next.signals.engagementNorm, safeAlpha)),
      growthNorm: round2(blendNumber(previous.signals.growthNorm, next.signals.growthNorm, safeAlpha)),
    },
    weights: {
      clipOverall,
      beatCoverage,
      narrativeBlend,
      engagementBlend,
      mergeClipScores: {
        hook: normalizePair(1 - hookMergeRaw, hookMergeRaw, 0.15, 0.35),
        flow: normalizePair(1 - flowMergeRaw, flowMergeRaw, 0.2, 0.35),
        engagement: normalizePair(1 - engagementMergeRaw, engagementMergeRaw, 0.18, 0.35),
        completeness: normalizePair(1 - completenessMergeRaw, completenessMergeRaw, 0.1, 0.45),
      },
      variant: {
        narrative: variantNarrative,
        engagement: variantEngagement,
        overall: variantOverall,
        kindBias: {
          safe: round2(blendNumber(previous.weights.variant.kindBias.safe, next.weights.variant.kindBias.safe, safeAlpha)),
          balanced: 0,
          aggressive: round2(
            blendNumber(previous.weights.variant.kindBias.aggressive, next.weights.variant.kindBias.aggressive, safeAlpha),
          ),
        },
        flatPenalty: Math.round(
          clamp(blendNumber(previous.weights.variant.flatPenalty, next.weights.variant.flatPenalty, safeAlpha), 10, 26),
        ),
      },
      qualityGate: {
        thresholds: {
          hook: Math.round(clamp(blendNumber(previous.weights.qualityGate.thresholds.hook, next.weights.qualityGate.thresholds.hook, safeAlpha), 28, 52)),
          completeness: Math.round(
            clamp(
              blendNumber(
                previous.weights.qualityGate.thresholds.completeness,
                next.weights.qualityGate.thresholds.completeness,
                safeAlpha,
              ),
              48,
              82,
            ),
          ),
          narrative: Math.round(
            clamp(
              blendNumber(
                previous.weights.qualityGate.thresholds.narrative,
                next.weights.qualityGate.thresholds.narrative,
                safeAlpha,
              ),
              48,
              82,
            ),
          ),
          engagement: Math.round(
            clamp(
              blendNumber(
                previous.weights.qualityGate.thresholds.engagement,
                next.weights.qualityGate.thresholds.engagement,
                safeAlpha,
              ),
              44,
              82,
            ),
          ),
        },
        blend: qualityGateBlend,
        issuePenalty: Math.round(
          clamp(blendNumber(previous.weights.qualityGate.issuePenalty, next.weights.qualityGate.issuePenalty, safeAlpha), 6, 16),
        ),
        passMinScore: Math.round(
          clamp(blendNumber(previous.weights.qualityGate.passMinScore, next.weights.qualityGate.passMinScore, safeAlpha), 50, 80),
        ),
      },
      antiFlat: {
        hookFloor: Math.round(
          clamp(blendNumber(previous.weights.antiFlat.hookFloor, next.weights.antiFlat.hookFloor, safeAlpha), 26, 46),
        ),
        completenessFloor: Math.round(
          clamp(
            blendNumber(previous.weights.antiFlat.completenessFloor, next.weights.antiFlat.completenessFloor, safeAlpha),
            48,
            78,
          ),
        ),
        flatRiskHook: Math.round(
          clamp(blendNumber(previous.weights.antiFlat.flatRiskHook, next.weights.antiFlat.flatRiskHook, safeAlpha), 28, 54),
        ),
        flatRiskCompleteness: Math.round(
          clamp(
            blendNumber(
              previous.weights.antiFlat.flatRiskCompleteness,
              next.weights.antiFlat.flatRiskCompleteness,
              safeAlpha,
            ),
            46,
            74,
          ),
        ),
        flatRiskMissingBeats: Math.round(
          clamp(
            blendNumber(
              previous.weights.antiFlat.flatRiskMissingBeats,
              next.weights.antiFlat.flatRiskMissingBeats,
              safeAlpha,
            ),
            1,
            3,
          ),
        ),
      },
    },
  };
}

function isProfileLike(value: unknown): value is AdaptiveScoringProfile {
  if (!value || typeof value !== "object") return false;
  const obj = value as AdaptiveScoringProfile;
  return (
    obj.version === 1 &&
    typeof obj.updatedAt === "string" &&
    typeof obj.weights?.clipOverall?.hook === "number" &&
    typeof obj.weights?.qualityGate?.passMinScore === "number"
  );
}

async function saveProfile(profile: AdaptiveScoringProfile): Promise<void> {
  inMemoryProfile = profile;
  await fs.mkdir(benchmarksDir, { recursive: true });
  await fs.writeFile(PROFILE_FILE, JSON.stringify(profile, null, 2), "utf-8");
}

export function getDefaultAdaptiveScoringProfile(): AdaptiveScoringProfile {
  return deepClone(DEFAULT_PROFILE);
}

export function getAdaptiveScoringProfile(): AdaptiveScoringProfile {
  return inMemoryProfile ?? DEFAULT_PROFILE;
}

export async function readAdaptiveScoringProfile(): Promise<AdaptiveScoringProfile> {
  if (inMemoryProfile) return inMemoryProfile;

  try {
    const raw = await fs.readFile(PROFILE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isProfileLike(parsed)) {
      inMemoryProfile = parsed;
      return parsed;
    }
  } catch {
    // fall through
  }

  inMemoryProfile = deepClone(DEFAULT_PROFILE);
  return inMemoryProfile;
}

export async function trainAdaptiveScoringFromPlatformReports(
  platforms: AdaptivePlatformTrainingInput[],
  options?: { force?: boolean },
): Promise<AdaptiveLearningResult> {
  const enabled = readBoolEnv("ADAPTIVE_SCORING_ENABLED", true);
  const currentProfile = await readAdaptiveScoringProfile();

  if (!enabled) {
    return {
      updated: false,
      reason: "disabled",
      profile: currentProfile,
      sampleCount: currentProfile.sampleCount,
      platformCount: currentProfile.platformCount,
    };
  }

  const usable = platforms
    .filter((platform) => platform.status !== "unavailable")
    .map((platform) => computePlatformFeatures(platform))
    .filter((feature): feature is PlatformFeatures => feature !== null);

  const sampleCount = usable.reduce((acc, feature) => acc + feature.sampleCount, 0);
  const platformCount = usable.length;
  const minSamples = Math.round(readNumberEnv("ADAPTIVE_SCORING_MIN_SAMPLES", 8, 3, 200));

  if (sampleCount < minSamples || platformCount === 0) {
    return {
      updated: false,
      reason: "not-enough-samples",
      profile: currentProfile,
      sampleCount,
      platformCount,
    };
  }

  const force = options?.force ?? false;
  const intervalMinutes = Math.round(readNumberEnv("ADAPTIVE_SCORING_MIN_INTERVAL_MINUTES", 180, 5, 10_080));
  const lastUpdatedMs = parseIsoDate(currentProfile.updatedAt);
  if (!force && lastUpdatedMs !== null) {
    const elapsedMs = Date.now() - lastUpdatedMs;
    if (elapsedMs < intervalMinutes * 60_000) {
      return {
        updated: false,
        reason: "rate-limited",
        profile: currentProfile,
        sampleCount,
        platformCount,
      };
    }
  }

  const candidate = buildLearnedCandidate(usable);
  const smoothing = readNumberEnv("ADAPTIVE_SCORING_SMOOTHING", 0.35, 0.05, 1);
  const firstLearn = currentProfile.source !== "learned";
  const alpha = force ? Math.max(smoothing, 0.8) : firstLearn ? Math.max(0.65, smoothing) : smoothing;
  const nextProfile = blendProfiles(currentProfile, candidate, alpha);

  await saveProfile(nextProfile);
  return {
    updated: true,
    reason: "updated",
    profile: nextProfile,
    sampleCount,
    platformCount,
  };
}

export function formatAdaptiveProfileSummary(profile: AdaptiveScoringProfile): string {
  const clip = profile.weights.clipOverall;
  return [
    `Adaptive scoring: ${profile.source}`,
    `muestras=${profile.sampleCount}`,
    `plataformas=${profile.platformCount}`,
    `hook=${Math.round(clip.hook * 100)}%`,
    `flow=${Math.round(clip.flow * 100)}%`,
    `engage=${Math.round(clip.engagement * 100)}%`,
    `completitud=${Math.round(clip.completeness * 100)}%`,
  ].join(" · ");
}
