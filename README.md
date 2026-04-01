# ViralClips Local MVP

MVP local para generar clips verticales desde un video largo.

## Funcionalidades

- Subida de video local (MP4 y otras fuentes compatibles con FFmpeg).
- Generacion automatica de clips verticales 1080x1920.
- Overlay de titulo en parte superior.
- Overlay de marca de agua en parte inferior.
- Subtitulos automaticos opcionales con OpenAI.
- Descarga directa de cada clip generado.

## Stack

- Next.js 16 (App Router)
- React 19
- Tailwind CSS v4
- FFmpeg local
- OpenAI API opcional para transcripcion

## Requisitos

1. Node.js 20+
2. FFmpeg instalado y accesible por terminal
3. (Opcional) OPENAI_API_KEY para subtitulos automaticos

## Instalacion

```bash
npm install
copy .env.example .env.local
```

Edita `.env.local` si necesitas rutas custom:

```env
OPENAI_API_KEY=
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

## Correr en local

```bash
npm run dev
```

Abre http://localhost:3000.

## Flujo de uso

1. Sube tu video fuente.
2. Define titulo, marca de agua, cantidad de clips y duracion.
3. Ejecuta procesamiento.
4. Descarga cada clip final.

## Estructura importante

- `src/app/api/process/route.ts`: endpoint principal del pipeline.
- `src/lib/video-pipeline.ts`: recorte, overlays y transcripcion.
- `src/app/api/download/[file]/route.ts`: streaming de clips finales.
- `storage/outputs/`: clips generados.

## Notas de operacion

- Si no existe `OPENAI_API_KEY`, el sistema igualmente genera clips sin subtitulos.
- Si OpenAI devuelve `429` (cuota/billing), el pipeline entra en fallback contextual sin transcripcion, priorizando ventanas largas guiadas por cambios de escena.
- El pipeline usa hooks virales estilo top con 3 formulas (configurable por `VIRAL_HOOK_STYLE`; por defecto `top3`):
  - `Nunca hagas (x) porque es lo peor que puedes hacer`
  - `Hice (x) y esto paso`
  - `Si vas a hacer (x), primero mira este video`
- Puedes ajustar la duracion del fallback sin transcripcion con:
  - `CLIP_NO_TRANSCRIPT_MIN_DURATION_SECONDS`
  - `CLIP_NO_TRANSCRIPT_MAX_DURATION_SECONDS`
  - `CLIP_NO_TRANSCRIPT_MIN_GAP_SECONDS`
- El pipeline incluye "quality rescue" para clips con gate/engagement bajos; puedes calibrarlo con `QUALITY_RESCUE_ENABLED`, `QUALITY_RESCUE_MAX_EXTRA_SECONDS`, `QUALITY_RESCUE_MIN_GATE_GAIN`, `QUALITY_RESCUE_TRIGGER_MARGIN` y `QUALITY_RESCUE_MAX_EARLY_SHIFT_SECONDS`.
- Para evitar clips casi duplicados, ajusta `CLIP_DIVERSITY_MAX_OVERLAP_RATIO` y `CLIP_DIVERSITY_MIN_SEPARATION_SECONDS`.
- Para evitar que la diversidad empeore el resultado, usa `CLIP_DIVERSITY_MAX_GATE_DROP` y `CLIP_DIVERSITY_REQUIRE_PASS_WHEN_TOP_PASS`.
- Para no quemar texto en el video final, deja `HOOK_TEXT_OVERLAY_ENABLED=false` y `HOOK_OPTIMIZER_TRANSITION_TEXT_ENABLED=false`.
- El pipeline prioriza estabilidad para MVP local, no velocidad maxima.
- Puedes limpiar `storage/outputs` y `storage/tmp` manualmente cuando quieras.
