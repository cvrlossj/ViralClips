"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Film, Sparkles, WandSparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";

type ClipResult = {
  fileName: string;
  url: string;
  startSeconds: number;
  durationSeconds: number;
  hasSubtitles: boolean;
  score: number;
  rationale: string;
};

type ProcessResponse = {
  jobId: string;
  clips: ClipResult[];
  notes: string[];
};

export default function Home() {
  const [video, setVideo] = useState<File | null>(null);
  const [title, setTitle] = useState("Momento viral del dia");
  const [watermark, setWatermark] = useState("@TuCanal");
  const [clips, setClips] = useState(6);
  const [clipDuration, setClipDuration] = useState(28);
  const [smartMode, setSmartMode] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<ProcessResponse | null>(null);
  const [processingStatus, setProcessingStatus] = useState(
    "Esperando parametros para iniciar.",
  );
  const [backendReady, setBackendReady] = useState<boolean | null>(null);
  const [backendMessage, setBackendMessage] = useState(
    "Comprobando estado del backend...",
  );
  const [progressValue, setProgressValue] = useState(0);
  const [progressStage, setProgressStage] = useState("En espera");
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [processingStartedAt, setProcessingStartedAt] = useState<number | null>(
    null,
  );

  useEffect(() => {
    let mounted = true;

    const validateBackend = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const payload = (await res.json()) as {
          ok?: boolean;
          message?: string;
          detail?: string;
        };

        if (!mounted) {
          return;
        }

        if (res.ok && payload.ok) {
          setBackendReady(true);
          setBackendMessage(payload.message ?? "Backend listo.");
          return;
        }

        setBackendReady(false);
        setBackendMessage(payload.message ?? payload.detail ?? "Backend no disponible.");
      } catch {
        if (!mounted) {
          return;
        }
        setBackendReady(false);
        setBackendMessage("No se pudo conectar con el backend local.");
      }
    };

    void validateBackend();

    return () => {
      mounted = false;
    };
  }, []);

  const canSubmit = useMemo(
    () => Boolean(video) && !loading && backendReady !== false,
    [video, loading, backendReady],
  );

  const selectedVideoInfo = useMemo(() => {
    if (!video) {
      return null;
    }

    const sizeMb = video.size / (1024 * 1024);
    return {
      name: video.name,
      sizeLabel:
        sizeMb >= 1024
          ? `${(sizeMb / 1024).toFixed(2)} GB`
          : `${sizeMb.toFixed(2)} MB`,
      type: video.type || "tipo no detectado",
    };
  }, [video]);

  useEffect(() => {
    if (!loading || processingStartedAt === null) {
      return;
    }

    const estimateSeconds = Math.min(
      300,
      Math.max(35, clips * 8 + clipDuration * 0.9 + (smartMode ? 20 : 0)),
    );
    const estimateMs = estimateSeconds * 1000;

    const update = () => {
      const elapsedMs = Date.now() - processingStartedAt;
      const projected = Math.min(94, 6 + (elapsedMs / estimateMs) * 88);

      setProgressValue((prev) => (projected > prev ? projected : prev));

      const remainMs = Math.max(0, estimateMs - elapsedMs);
      setEtaSeconds(Math.ceil(remainMs / 1000));

      if (projected < 20) {
        setProgressStage("Subiendo video");
      } else if (projected < 45) {
        setProgressStage("Transcribiendo audio");
      } else if (projected < 70) {
        setProgressStage("Detectando escenas y score");
      } else {
        setProgressStage("Renderizando clips finales");
      }
    };

    update();
    const interval = window.setInterval(update, 350);

    return () => {
      window.clearInterval(interval);
    };
  }, [loading, processingStartedAt, clips, clipDuration, smartMode]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!video) {
      setError("Sube un video para continuar.");
      return;
    }

    const form = new FormData();
    form.append("video", video);
    form.append("title", title);
    form.append("watermark", watermark);
    form.append("clips", String(clips));
    form.append("clipDuration", String(clipDuration));
    form.append("smartMode", String(smartMode));

    setLoading(true);
    setError(null);
    setResponse(null);
    setProgressValue(4);
    setProgressStage("Subiendo video");
    setEtaSeconds(null);
    setProcessingStartedAt(Date.now());
    setProcessingStatus("Subiendo video al backend local...");

    try {
      setProcessingStatus("Analizando transcripcion, escenas y ranking...");
      const res = await fetch("/api/process", {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        const payload = (await res.json()) as { error?: string };
        throw new Error(payload.error ?? "No se pudo procesar el video.");
      }

      const payload = (await res.json()) as ProcessResponse;
      setResponse(payload);
      setProcessingStatus("Clips generados correctamente.");
      setProgressStage("Completado");
      setProgressValue(100);
      setEtaSeconds(0);
    } catch (submitError) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : "Error inesperado durante el procesamiento.";
      setError(message);
      setProcessingStatus("Fallo en procesamiento. Revisa el detalle del error.");
      setProgressStage("Error en procesamiento");
    } finally {
      setLoading(false);
      setProcessingStartedAt(null);
    }
  };

  return (
    <div className="grain min-h-screen">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
        <Card className="relative overflow-hidden border-2 bg-[var(--surface)]">
          <div className="absolute right-0 top-0 h-52 w-52 -translate-y-1/3 translate-x-1/4 rounded-full bg-[var(--accent)]/20 blur-2xl" />
          <CardHeader className="relative gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="accent" className="font-mono tracking-wide">
                STUDIO AI LOCAL
              </Badge>
              <Badge className="font-mono tracking-wide">RANKING NARRATIVO</Badge>
            </div>
            <CardTitle className="max-w-4xl text-3xl leading-tight sm:text-5xl">
              Editor de clips virales con deteccion de escenas y re-ranking LLM
            </CardTitle>
            <CardDescription className="max-w-3xl text-sm leading-7 sm:text-base">
              El motor detecta cambios visuales, analiza transcripcion y luego aplica
              un ranking final para elegir clips con mayor potencial de retencion.
            </CardDescription>
          </CardHeader>
        </Card>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <Card className="border-2 bg-[var(--surface)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-2xl">
                <Film className="h-5 w-5" /> Parametros de produccion
              </CardTitle>
              <CardDescription>
                Ajusta la salida y ejecuta un pipeline completo de recorte inteligente.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <form className="space-y-5" onSubmit={handleSubmit}>
                <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-4 py-3 text-sm">
                  <p className="font-semibold">Estado backend</p>
                  <p className="mt-1 text-[13px] text-[var(--foreground)]/80">
                    {backendMessage}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="video">Video fuente</Label>
                  <Input
                    id="video"
                    type="file"
                    accept="video/*"
                    onChange={(event) => setVideo(event.target.files?.[0] ?? null)}
                    className="h-12 file:mr-4 file:rounded-md file:border-0 file:bg-[var(--line)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[var(--surface)]"
                  />

                  {selectedVideoInfo ? (
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-4 py-3 text-xs leading-6">
                      <p className="font-semibold">Archivo detectado</p>
                      <p>Nombre: {selectedVideoInfo.name}</p>
                      <p>Tamano: {selectedVideoInfo.sizeLabel}</p>
                      <p>Formato: {selectedVideoInfo.type}</p>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--foreground)]/70">
                      Aun no hay archivo seleccionado.
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="title">Titulo superior</Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Ejemplo: Lo que paso en este stream"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="watermark">Marca de agua</Label>
                  <Input
                    id="watermark"
                    value={watermark}
                    onChange={(event) => setWatermark(event.target.value)}
                    placeholder="@TuMarca"
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="clips">Numero de clips</Label>
                    <Input
                      id="clips"
                      type="number"
                      min={1}
                      max={12}
                      value={clips}
                      onChange={(event) => setClips(Number(event.target.value))}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="clipDuration">Duracion por clip (s)</Label>
                    <Input
                      id="clipDuration"
                      type="number"
                      min={8}
                      max={90}
                      value={clipDuration}
                      onChange={(event) => setClipDuration(Number(event.target.value))}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold">Modo inteligente</p>
                    <p className="text-xs text-[var(--foreground)]/75">
                      Escenas + transcripcion + re-ranking final con LLM.
                    </p>
                  </div>
                  <Switch checked={smartMode} onCheckedChange={setSmartMode} />
                </div>

                <Button type="submit" disabled={!canSubmit} className="h-11 w-full">
                  {loading ? (
                    <span className="inline-flex items-center gap-2">
                      <WandSparkles className="h-4 w-4 animate-pulse" /> Procesando
                      pipeline...
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <Sparkles className="h-4 w-4" /> Generar clips virales
                    </span>
                  )}
                </Button>

                {!canSubmit && (
                  <p className="text-xs text-[var(--foreground)]/75">
                    {!video
                      ? "Carga un video para habilitar la generacion."
                      : backendReady === false
                        ? "Backend no listo: revisa FFmpeg/FFprobe y luego recarga."
                        : "Esperando disponibilidad del sistema."}
                  </p>
                )}
              </form>
            </CardContent>
          </Card>

          <Card className="border-2 bg-[var(--surface)]">
            <CardHeader>
              <CardTitle className="text-2xl">Panel de calidad</CardTitle>
              <CardDescription>
                Resultado final de cada clip con score y razon del recorte.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3 text-sm">
                {processingStatus}
              </div>

              <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
                <div className="mb-2 flex items-center justify-between text-xs font-mono">
                  <span>{progressStage}</span>
                  <span>{Math.round(progressValue)}%</span>
                </div>
                <Progress value={progressValue} />
                <p className="mt-2 text-xs text-[var(--foreground)]/75">
                  {loading
                    ? `Procesando... ETA aprox: ${etaSeconds ?? "--"}s`
                    : progressValue >= 100
                      ? "Proceso finalizado"
                      : "Aun no inicia procesamiento"}
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <Badge className="justify-center py-1 font-mono">Transcripcion</Badge>
                <Badge className="justify-center py-1 font-mono">Escenas</Badge>
                <Badge className="justify-center py-1 font-mono">Re-ranking LLM</Badge>
              </div>

              {error && (
                <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                  {error}
                </div>
              )}

              {!error && !response && (
                <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--surface-2)] p-5 text-sm">
                  Esperando video para iniciar procesamiento.
                </div>
              )}

              {response && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-4 text-sm">
                    <p className="font-semibold">Job ID: {response.jobId}</p>
                    {response.notes.map((note) => (
                      <p className="mt-2 text-[13px]" key={note}>
                        {note}
                      </p>
                    ))}
                  </div>

                  <ul className="space-y-4">
                    {response.clips.map((clip) => (
                      <li key={clip.fileName} className="rounded-xl border border-[var(--line)] bg-white p-4">
                        <video
                          controls
                          className="aspect-[9/16] w-full rounded-lg border border-[var(--line)] bg-black"
                          src={clip.url}
                        />
                        <p className="mt-3 text-sm font-semibold">{clip.fileName}</p>
                        <p className="mt-1 text-xs font-mono leading-6">
                          inicio {clip.startSeconds.toFixed(1)}s · duracion {clip.durationSeconds.toFixed(1)}s · subtitulos {clip.hasSubtitles ? "si" : "no"}
                        </p>
                        <p className="mt-1 text-xs font-mono leading-6">
                          score narrativo {clip.score.toFixed(2)} · {clip.rationale}
                        </p>
                        <Button asChild variant="secondary" className="mt-3 w-full">
                          <a href={clip.url} download className="w-full text-center">
                            Descargar clip
                          </a>
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}
