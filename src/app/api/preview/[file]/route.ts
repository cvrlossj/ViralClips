import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { sourcesDir, outputDir } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sanitize(value: string) {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, "");
}

export async function GET(
  request: Request,
  context: { params: Promise<{ file: string }> },
) {
  const { file } = await context.params;
  const safe = sanitize(file);

  // Look in sources first, then outputs (for rendered clips)
  let filePath = path.join(sourcesDir, safe);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(outputDir, safe);
  }
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 });
  }

  const stat = fs.statSync(filePath);
  const size = stat.size;
  const range = request.headers.get("range");

  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      return new NextResponse("Invalid range", { status: 416 });
    }

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : size - 1;
    const chunkSize = end - start + 1;

    const stream = fs.createReadStream(filePath, { start, end });

    return new NextResponse(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(chunkSize),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  const stream = fs.createReadStream(filePath);

  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
