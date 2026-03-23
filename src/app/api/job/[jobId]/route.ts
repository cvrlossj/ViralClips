import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobsDir, outputDir, sourcesDir } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sanitize(value: string) {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, "");
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const safe = sanitize(jobId);
  const manifestPath = path.join(jobsDir, `${safe}.json`);

  try {
    const data = await fs.readFile(manifestPath, "utf-8");
    return new NextResponse(data, {
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return NextResponse.json(
      { error: "Job no encontrado." },
      { status: 404 },
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const safe = sanitize(jobId);

  try {
    // Read manifest to find associated files
    const manifestPath = path.join(jobsDir, `${safe}.json`);
    let clipFileNames: string[] = [];
    let sourceVideoPath = "";

    try {
      const data = await fs.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(data);
      clipFileNames = (manifest.clips ?? []).map((c: { fileName: string }) => c.fileName);
      sourceVideoPath = manifest.sourceVideoPath ?? "";
    } catch {
      // Manifest might not exist, still try to clean up
    }

    // Delete clip files
    await Promise.all(
      clipFileNames.map((name: string) =>
        fs.rm(path.join(outputDir, name), { force: true }),
      ),
    );

    // Delete source video
    if (sourceVideoPath) {
      await fs.rm(sourceVideoPath, { force: true });
    }

    // Also try by convention: sourcesDir/{jobId}.*
    try {
      const sourceFiles = await fs.readdir(sourcesDir);
      for (const f of sourceFiles) {
        if (f.startsWith(safe)) {
          await fs.rm(path.join(sourcesDir, f), { force: true });
        }
      }
    } catch { /* sourcesDir might not exist */ }

    // Delete manifest
    await fs.rm(manifestPath, { force: true });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Error eliminando el job." },
      { status: 500 },
    );
  }
}
