import fs from "node:fs/promises";
import path from "node:path";
import { getMediaStreamInfo } from "@/lib/ffmpeg";
import { jobsDir, outputDir } from "@/lib/paths";

type ManifestClip = {
  fileName: string;
  durationSeconds?: number;
  overallScore?: number;
  qualityFlags?: string[];
  qualityGateStatus?: "pass" | "review" | string;
  qualityGateScore?: number;
};

type JobManifestLike = {
  jobId: string;
  clips?: ManifestClip[];
};

export type ClipQualityReport = {
  index: number;
  fileName: string;
  gateStatus: "pass" | "review";
  gateScore: number;
  expectedDurationSeconds: number;
  outputDurationSeconds: number;
  resolution: string;
  hasAudio: boolean;
  overallScore: number;
  technicalIssues: string[];
  qualityFlags: string[];
};

export type JobQualityReport = {
  jobId: string;
  generatedAt: string;
  thresholds: {
    minPassRatio: number;
    minAvgGateScore: number;
    minClipDurationSeconds: number;
  };
  summary: {
    status: "pass" | "review";
    clipCount: number;
    passCount: number;
    reviewCount: number;
    passRatio: number;
    avgGateScore: number;
    avgOverallScore: number;
    technicalIssueCount: number;
    topIssues: Array<{ issue: string; count: number }>;
  };
  clips: ClipQualityReport[];
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function readNumberEnv(name: string, fallback: number, min: number, max: number) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return clamp(raw, min, max);
}

const MIN_PASS_RATIO = readNumberEnv("QUALITY_MIN_PASS_RATIO", 0.6, 0.2, 1);
const MIN_AVG_GATE_SCORE = readNumberEnv("QUALITY_MIN_AVG_GATE_SCORE", 62, 40, 95);
const MIN_CLIP_DURATION_SECONDS = readNumberEnv("CLIP_MIN_DURATION_SECONDS", 36, 20, 120);

function sanitizeJobId(value: string) {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, "");
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

export async function loadJobQualityReport(jobId: string): Promise<JobQualityReport> {
  const safeJobId = sanitizeJobId(jobId);
  const manifestPath = path.join(jobsDir, `${safeJobId}.json`);
  const raw = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as JobManifestLike;
  return buildJobQualityReport(manifest);
}

export async function buildJobQualityReport(manifest: JobManifestLike): Promise<JobQualityReport> {
  const clips = manifest.clips ?? [];
  const issueCounter = new Map<string, number>();
  const clipReports: ClipQualityReport[] = [];

  let passCount = 0;
  let reviewCount = 0;
  let gateScoreSum = 0;
  let overallScoreSum = 0;
  let technicalIssueCount = 0;

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const outputPath = path.join(outputDir, clip.fileName);
    const technicalIssues: string[] = [];
    let outputDurationSeconds = 0;
    let resolution = "n/a";
    let hasAudio = false;

    try {
      await fs.access(outputPath);
    } catch {
      technicalIssues.push("archivo-no-encontrado");
    }

    if (technicalIssues.length === 0) {
      try {
        const stream = await getMediaStreamInfo(outputPath);
        outputDurationSeconds = stream.duration;
        resolution = `${stream.width}x${stream.height}`;
        hasAudio = stream.hasAudio;

        if (stream.width !== 1080 || stream.height !== 1920) {
          technicalIssues.push(`formato-${stream.width}x${stream.height}`);
        }
        if (stream.duration < MIN_CLIP_DURATION_SECONDS - 1) {
          technicalIssues.push(`duracion-corta-${stream.duration.toFixed(1)}s`);
        }
        if (!stream.hasAudio) {
          technicalIssues.push("sin-audio");
        }
      } catch {
        technicalIssues.push("ffprobe-fallo");
      }
    }

    const qualityFlags = clip.qualityFlags ?? [];
    const gateScore = clamp(Math.round(clip.qualityGateScore ?? 0), 0, 100);
    const overallScore = clamp(Math.round(clip.overallScore ?? 0), 0, 100);
    const expectedDurationSeconds = Number.isFinite(clip.durationSeconds)
      ? Math.max(0, clip.durationSeconds ?? 0)
      : 0;
    const baseStatus = clip.qualityGateStatus?.toLowerCase() === "pass" ? "pass" : "review";
    const gateStatus: "pass" | "review" = technicalIssues.length === 0 && baseStatus === "pass"
      ? "pass"
      : "review";

    for (const issue of [...technicalIssues, ...qualityFlags]) {
      issueCounter.set(issue, (issueCounter.get(issue) ?? 0) + 1);
    }

    if (gateStatus === "pass") {
      passCount += 1;
    } else {
      reviewCount += 1;
    }

    gateScoreSum += gateScore;
    overallScoreSum += overallScore;
    technicalIssueCount += technicalIssues.length;

    clipReports.push({
      index: index + 1,
      fileName: clip.fileName,
      gateStatus,
      gateScore,
      expectedDurationSeconds: round2(expectedDurationSeconds),
      outputDurationSeconds: round2(outputDurationSeconds),
      resolution,
      hasAudio,
      overallScore,
      technicalIssues,
      qualityFlags,
    });
  }

  const clipCount = clipReports.length;
  const passRatio = clipCount > 0 ? passCount / clipCount : 0;
  const avgGateScore = clipCount > 0 ? gateScoreSum / clipCount : 0;
  const avgOverallScore = clipCount > 0 ? overallScoreSum / clipCount : 0;
  const topIssues = [...issueCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([issue, count]) => ({ issue, count }));

  const status: "pass" | "review" =
    clipCount > 0 &&
    passRatio >= MIN_PASS_RATIO &&
    avgGateScore >= MIN_AVG_GATE_SCORE
      ? "pass"
      : "review";

  return {
    jobId: manifest.jobId,
    generatedAt: new Date().toISOString(),
    thresholds: {
      minPassRatio: MIN_PASS_RATIO,
      minAvgGateScore: MIN_AVG_GATE_SCORE,
      minClipDurationSeconds: MIN_CLIP_DURATION_SECONDS,
    },
    summary: {
      status,
      clipCount,
      passCount,
      reviewCount,
      passRatio: round2(passRatio),
      avgGateScore: round2(avgGateScore),
      avgOverallScore: round2(avgOverallScore),
      technicalIssueCount,
      topIssues,
    },
    clips: clipReports,
  };
}
