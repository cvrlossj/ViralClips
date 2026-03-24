import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WATERMARK_DIR = path.join(storageRoot, "watermark");
const VALID_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/**
 * GET /api/watermarks
 * List all watermark images available in storage/watermark/
 */
export async function GET() {
  try {
    await fs.mkdir(WATERMARK_DIR, { recursive: true });
    const files = await fs.readdir(WATERMARK_DIR);

    const watermarks = files
      .filter((f) => VALID_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .map((f) => ({
        fileName: f,
        name: path.basename(f, path.extname(f)).replace(/[_-]/g, " "),
        previewUrl: `/api/watermarks/${encodeURIComponent(f)}`,
      }));

    return NextResponse.json(watermarks);
  } catch {
    return NextResponse.json([]);
  }
}
