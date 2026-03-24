import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { benchmarksDir } from "@/lib/paths";
import type { ViralBenchmark } from "@/lib/tiktok-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BENCHMARK_FILE = path.join(benchmarksDir, "active-benchmark.json");

/**
 * GET /api/tiktok/benchmark
 * Load the currently active benchmark (if any).
 */
export async function GET() {
  try {
    const raw = await fs.readFile(BENCHMARK_FILE, "utf-8");
    const data = JSON.parse(raw) as { benchmark: ViralBenchmark; source: string; savedAt: string };
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ benchmark: null, source: null, savedAt: null });
  }
}

/**
 * POST /api/tiktok/benchmark
 * Save a benchmark as the active one (used to calibrate clip detection).
 * Body: { benchmark: ViralBenchmark, source: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { benchmark?: ViralBenchmark; source?: string };
    if (!body.benchmark || body.benchmark.totalAnalyzed === 0) {
      return NextResponse.json({ error: "Benchmark vacio o invalido." }, { status: 400 });
    }

    await fs.mkdir(benchmarksDir, { recursive: true });

    const payload = {
      benchmark: body.benchmark,
      source: String(body.source ?? "manual"),
      savedAt: new Date().toISOString(),
    };

    await fs.writeFile(BENCHMARK_FILE, JSON.stringify(payload, null, 2), "utf-8");

    return NextResponse.json({ ok: true, savedAt: payload.savedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/tiktok/benchmark
 * Remove the active benchmark.
 */
export async function DELETE() {
  try {
    await fs.rm(BENCHMARK_FILE, { force: true });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
