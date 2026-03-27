import { NextResponse } from "next/server";
import { loadJobQualityReport } from "@/lib/job-quality-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sanitize(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "");
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const safeJobId = sanitize(jobId);

  try {
    const report = await loadJobQualityReport(safeJobId);
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error calculando calidad del job.";
    const status = message.includes("ENOENT") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
