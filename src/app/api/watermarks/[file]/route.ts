import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WATERMARK_DIR = path.join(storageRoot, "watermark");

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * GET /api/watermarks/[file]
 * Serve a watermark image for preview in the UI.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  const safeName = path.basename(decodeURIComponent(file));
  const ext = path.extname(safeName).toLowerCase();
  const mime = MIME_TYPES[ext];

  if (!mime) {
    return NextResponse.json({ error: "Tipo de archivo no soportado" }, { status: 400 });
  }

  const filePath = path.join(WATERMARK_DIR, safeName);

  try {
    const data = await fs.readFile(filePath);
    return new NextResponse(data, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Archivo no encontrado" }, { status: 404 });
  }
}
