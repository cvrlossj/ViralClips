import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobsDir } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JobSummary = {
  jobId: string;
  sourceFileName: string;
  clipCount: number;
  createdAt: string;
};

export async function GET() {
  try {
    await fs.mkdir(jobsDir, { recursive: true });
    const files = await fs.readdir(jobsDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json")).sort().reverse();

    // Read only the last 20 jobs for performance
    const summaries: JobSummary[] = [];
    for (const file of jsonFiles.slice(0, 20)) {
      try {
        const data = await fs.readFile(path.join(jobsDir, file), "utf-8");
        const manifest = JSON.parse(data);
        summaries.push({
          jobId: manifest.jobId,
          sourceFileName: manifest.sourceFileName,
          clipCount: manifest.clips?.length ?? 0,
          createdAt: manifest.createdAt,
        });
      } catch {
        // Skip corrupt manifests
      }
    }

    return NextResponse.json(summaries);
  } catch {
    return NextResponse.json([]);
  }
}
