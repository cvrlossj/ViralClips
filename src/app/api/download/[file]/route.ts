import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { outputDir } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sanitizeFileName(value: string) {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, "");
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ file: string }> },
) {
  const params = await context.params;
  const fileName = sanitizeFileName(params.file);
  const filePath = path.join(outputDir, fileName);

  if (!fileName || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 });
  }

  const stream = fs.createReadStream(filePath);

  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename=\"${fileName}\"`,
      "Cache-Control": "no-store",
    },
  });
}
