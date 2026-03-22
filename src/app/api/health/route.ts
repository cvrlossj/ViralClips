import { NextResponse } from "next/server";
import { assertFfmpegInstalled } from "@/lib/ffmpeg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await assertFfmpegInstalled();

    return NextResponse.json({
      ok: true,
      ffmpeg: true,
      openai: Boolean(process.env.OPENAI_API_KEY),
      message: "Backend listo para procesar clips.",
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudo validar FFmpeg/FFprobe.";

    return NextResponse.json(
      {
        ok: false,
        ffmpeg: false,
        openai: Boolean(process.env.OPENAI_API_KEY),
        message:
          "FFmpeg o FFprobe no disponibles. Verifica instalacion y PATH local.",
        detail: message,
      },
      { status: 500 },
    );
  }
}
