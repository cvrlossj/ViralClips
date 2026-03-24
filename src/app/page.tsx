"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  Download,
  Loader2,
  Pencil,
  Search,
  Settings2,
  Trash2,
  TrendingUp,
  Type,
  Upload,
  User,
  XCircle,
  Zap,
} from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type ClipScores = {
  hook: number;
  flow: number;
  engagement: number;
  completeness: number;
};

type ClipResult = {
  fileName: string;
  url: string;
  startSeconds: number;
  durationSeconds: number;
  hasSubtitles: boolean;
  scores: ClipScores;
  overallScore: number;
  rationale: string;
  title: string;
  hookText: string;
  descriptions: { tiktok: string; instagram: string; youtube: string };
  thumbnailUrl?: string;
  hookApplied?: boolean;
};

type ProcessResponse = {
  jobId: string;
  clips: ClipResult[];
  notes: string[];
};

type ViralBenchmark = {
  avgViews: number;
  avgLikes: number;
  avgShares: number;
  avgComments: number;
  avgDuration: number;
  avgEngagementRate: number;
  durationBuckets: { range: string; avgViews: number; count: number }[];
  topVideos: { id: string; title: string; views: number; duration: number; engagementRate: number }[];
  analyzedAt: string;
  totalAnalyzed: number;
};

type TikTokSearchResult = {
  id: string;
  title: string;
  duration: number;
  playCount: number;
  likeCount: number;
  shareCount: number;
  commentCount: number;
  author: string;
  coverUrl: string;
};

function formatSeconds(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatFileSize(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}


export default function Home() {
  const [video, setVideo] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [title, setTitle] = useState("Momento viral del dia");
  const [watermark, setWatermark] = useState("@TuCanal");
  const [clipCount, setClipCount] = useState(8);
  const [subtitleSize, setSubtitleSize] = useState(44);
  const [splitScreen, setSplitScreen] = useState(true);
  const [autoTitle, setAutoTitle] = useState(true);
  const [captionPreset, setCaptionPreset] = useState("hormozi");
  const [hookOptimizer, setHookOptimizer] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<ProcessResponse | null>(null);
  const [processingStatus, setProcessingStatus] = useState(
    "En espera de configuracion.",
  );
  const [backendReady, setBackendReady] = useState<boolean | null>(null);
  const [backendMessage, setBackendMessage] = useState("Verificando sistema...");
  const [progressValue, setProgressValue] = useState(0);
  const [progressStage, setProgressStage] = useState("En espera");
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [processingStartedAt, setProcessingStartedAt] = useState<number | null>(null);
  const [previousJobs, setPreviousJobs] = useState<
    Array<{ jobId: string; sourceFileName: string; clipCount: number; createdAt: string }>
  >([]);

  // TikTok Analytics state
  const [tiktokQuery, setTiktokQuery] = useState("");
  const [tiktokCreator, setTiktokCreator] = useState("");
  const [tiktokLoading, setTiktokLoading] = useState(false);
  const [tiktokVideos, setTiktokVideos] = useState<TikTokSearchResult[]>([]);
  const [tiktokBenchmark, setTiktokBenchmark] = useState<ViralBenchmark | null>(null);
  const [tiktokSource, setTiktokSource] = useState<string | null>(null);
  const [activeBenchmark, setActiveBenchmark] = useState<{ benchmark: ViralBenchmark; source: string; savedAt: string } | null>(null);
  const [tiktokError, setTiktokError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const payload = (await res.json()) as {
          ok?: boolean;
          message?: string;
          detail?: string;
        };
        if (!mounted) return;
        if (res.ok && payload.ok) {
          setBackendReady(true);
          setBackendMessage(payload.message ?? "Sistema listo.");
        } else {
          setBackendReady(false);
          setBackendMessage(payload.message ?? payload.detail ?? "Backend no disponible.");
        }
      } catch {
        if (!mounted) return;
        setBackendReady(false);
        setBackendMessage("No se pudo conectar con el backend.");
      }
    };
    void check();

    // Load previous job history
    fetch("/api/jobs", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => { if (mounted) setPreviousJobs(data); })
      .catch(() => {});

    // Load active TikTok benchmark
    fetch("/api/tiktok/benchmark", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => { if (mounted && data.benchmark) setActiveBenchmark(data); })
      .catch(() => {});

    return () => { mounted = false; };
  }, []);

  const canSubmit = useMemo(
    () => Boolean(video) && !loading && backendReady !== false,
    [video, loading, backendReady],
  );

  useEffect(() => {
    if (!loading || processingStartedAt === null) return;

    // Estimate based on file size + pipeline features
    const fileSizeMb = video ? video.size / (1024 * 1024) : 50;
    const uploadTimeSec = fileSizeMb / 15; // ~15 MB/s local write
    const transcriptionSec = Math.max(30, fileSizeMb * 0.12);
    const sceneSec = Math.max(20, fileSizeMb * 0.08);
    const visualAnalysisSec = Math.max(15, fileSizeMb * 0.06); // GPT-4o Vision keyframe analysis
    const renderSec = clipCount * 12; // Variable duration clips average ~30s
    const titleSec = clipCount * 3;
    const estimateMs = (uploadTimeSec + transcriptionSec + sceneSec + visualAnalysisSec + renderSec + titleSec) * 1000;

    const update = () => {
      const elapsed = Date.now() - processingStartedAt;
      // Progress curve: fast start, slows down as it approaches 94%
      const ratio = elapsed / estimateMs;
      const projected = Math.min(94, 6 + 88 * (1 - Math.exp(-2.5 * ratio)));
      setProgressValue((prev) => (projected > prev ? projected : prev));

      const remaining = Math.max(0, estimateMs - elapsed);
      // When past the estimate, show "procesando" instead of "0s"
      setEtaSeconds(remaining > 1000 ? Math.ceil(remaining / 1000) : null);

      // Dynamic stage based on elapsed proportion
      if (ratio < 0.08) setProgressStage("Subiendo video");
      else if (ratio < 0.30) setProgressStage("Transcribiendo audio");
      else if (ratio < 0.45) setProgressStage("Analizando frames (Vision AI)");
      else if (ratio < 0.55) setProgressStage("Detectando momentos virales");
      else if (ratio < 0.65) setProgressStage("Generando titulos");
      else setProgressStage("Renderizando clips");
    };

    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, [loading, processingStartedAt, clipCount, video]);

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) setVideo(file);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!video) return;

    const form = new FormData();
    form.append("video", video);
    form.append("title", title);
    form.append("watermark", watermark);
    form.append("clips", String(clipCount));
    form.append("subtitleSize", String(subtitleSize));
    form.append("splitScreen", String(splitScreen));
    form.append("autoTitle", String(autoTitle));
    form.append("captionPreset", captionPreset);
    form.append("hookOptimizer", String(hookOptimizer));

    setLoading(true);
    setError(null);
    setResponse(null);
    setProgressValue(4);
    setProgressStage("Subiendo video");
    setEtaSeconds(null);
    setProcessingStartedAt(Date.now());
    setProcessingStatus("Procesando...");

    try {
      const res = await fetch("/api/process", { method: "POST", body: form });
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error inesperado.";
      setError(msg);
      setProcessingStatus("Fallo en el pipeline.");
      setProgressStage("Error");
    } finally {
      setLoading(false);
      setProcessingStartedAt(null);
    }
  };

  const handleTiktokSearch = async () => {
    if (!tiktokQuery.trim()) return;
    setTiktokLoading(true);
    setTiktokError(null);
    setTiktokVideos([]);
    setTiktokBenchmark(null);
    try {
      const res = await fetch("/api/tiktok/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords: tiktokQuery.trim(), count: 30 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error en busqueda");
      setTiktokVideos(data.videos ?? []);
      setTiktokBenchmark(data.benchmark ?? null);
      setTiktokSource(`Busqueda: "${tiktokQuery.trim()}"`);
    } catch (err) {
      setTiktokError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setTiktokLoading(false);
    }
  };

  const handleTiktokCreator = async () => {
    if (!tiktokCreator.trim()) return;
    setTiktokLoading(true);
    setTiktokError(null);
    setTiktokVideos([]);
    setTiktokBenchmark(null);
    try {
      const res = await fetch("/api/tiktok/creator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: tiktokCreator.trim(), count: 30 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error analizando creador");
      setTiktokVideos(data.videos ?? []);
      setTiktokBenchmark(data.benchmark ?? null);
      setTiktokSource(`Creador: @${tiktokCreator.trim().replace(/^@/, "")}`);
    } catch (err) {
      setTiktokError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setTiktokLoading(false);
    }
  };

  const handleActivateBenchmark = async () => {
    if (!tiktokBenchmark) return;
    try {
      const res = await fetch("/api/tiktok/benchmark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ benchmark: tiktokBenchmark, source: tiktokSource }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error guardando benchmark");
      setActiveBenchmark({ benchmark: tiktokBenchmark, source: tiktokSource ?? "", savedAt: data.savedAt });
    } catch (err) {
      setTiktokError(err instanceof Error ? err.message : "Error desconocido");
    }
  };

  const handleDeactivateBenchmark = async () => {
    try {
      await fetch("/api/tiktok/benchmark", { method: "DELETE" });
      setActiveBenchmark(null);
    } catch { /* ignore */ }
  };

  return (
    <div className="grain min-h-screen">
{/* removed top nav — tool is personal, no navigation needed */}

      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-8">
        {/* Hero */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Generador de{" "}
            <span className="text-(--accent)">clips virales</span>
          </h1>
          <p className="mt-3 max-w-2xl text-base text-(--muted-fg)">
            Sube un video largo. El motor transcribe el audio, analiza frames con Vision AI,
            detecta escenas clave y combina audio + video para elegir los mejores momentos.
            Salida vertical 1080x1920 lista para publicar.
          </p>
        </div>

        {/* Main layout */}
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">

          {/* Left — tabbed form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-xl">Configuracion del pipeline</CardTitle>
              <CardDescription>
                Configura el video, los textos y los parametros de generacion.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-6">
                <Tabs defaultValue="video">
                  <TabsList className="w-full sm:w-auto">
                    <TabsTrigger value="video" className="flex items-center gap-1.5">
                      <Upload className="h-3.5 w-3.5" />
                      Video
                    </TabsTrigger>
                    <TabsTrigger value="texto" className="flex items-center gap-1.5">
                      <Type className="h-3.5 w-3.5" />
                      Overlay
                    </TabsTrigger>
                    <TabsTrigger value="clips" className="flex items-center gap-1.5">
                      <Settings2 className="h-3.5 w-3.5" />
                      Pipeline
                    </TabsTrigger>
                  </TabsList>

                  {/* Tab: Video upload */}
                  <TabsContent value="video">
                    <div
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`group cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-all duration-200 ${
                        isDragging
                          ? "border-(--accent) bg-(--accent)/8 scale-[1.01]"
                          : "border-(--line-2) bg-(--surface-2) hover:border-(--accent)/50 hover:bg-(--surface-3)"
                      }`}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={(e) => setVideo(e.target.files?.[0] ?? null)}
                      />

                      {video ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-center gap-2">
                            <CheckCircle2 className="h-5 w-5 text-(--accent-2)" />
                            <p className="font-semibold truncate max-w-xs">{video.name}</p>
                          </div>
                          <p className="text-sm text-(--muted-fg)">
                            {formatFileSize(video.size)} · {video.type || "video"}
                          </p>
                          <p className="text-xs text-(--muted-fg)/60 mt-2">
                            Clic para cambiar el archivo
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-(--surface-3) group-hover:bg-(--accent)/15 transition-colors">
                            <Upload className="h-5 w-5 text-(--muted-fg) group-hover:text-(--accent) transition-colors" />
                          </div>
                          <div>
                            <p className="font-medium">Arrastra tu video aqui</p>
                            <p className="text-sm text-(--muted-fg) mt-0.5">
                              o haz clic para seleccionar
                            </p>
                          </div>
                          <p className="text-xs text-(--muted-fg)/60">
                            MP4 · MOV · AVI · MKV · WebM
                          </p>
                        </div>
                      )}
                    </div>
                  </TabsContent>

                  {/* Tab: Text overlays */}
                  <TabsContent value="texto" className="space-y-5">
                    <div className="flex items-center justify-between rounded-lg border border-(--line) bg-(--surface-2) px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">Auto-titulo viral</p>
                        <p className="text-xs text-(--muted-fg) mt-0.5">
                          GPT genera un titulo unico y enganchante por cada clip.
                        </p>
                      </div>
                      <Switch checked={autoTitle} onCheckedChange={setAutoTitle} />
                    </div>

                    <div className={`space-y-2 transition-opacity ${autoTitle ? "opacity-40 pointer-events-none" : ""}`}>
                      <Label htmlFor="title">Titulo superior (manual)</Label>
                      <Input
                        id="title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Lo que paso en este stream..."
                        maxLength={80}
                        disabled={autoTitle}
                      />
                      <p className="text-xs text-(--muted-fg)">
                        {autoTitle
                          ? "Desactiva auto-titulo para escribir un titulo fijo."
                          : "Aparece en la barra oscura del top del video."}
                      </p>
                    </div>

                    <Separator />

                    <div className="space-y-2">
                      <Label htmlFor="watermark">Marca de agua</Label>
                      <Input
                        id="watermark"
                        value={watermark}
                        onChange={(e) => setWatermark(e.target.value)}
                        placeholder="@TuCanal"
                        maxLength={50}
                      />
                      <p className="text-xs text-(--muted-fg)">
                        Aparece en la barra inferior del video.
                      </p>
                    </div>

                    <Separator />

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>Tamano de subtitulos</Label>
                        <span className="font-mono text-sm text-(--accent)">{subtitleSize}px</span>
                      </div>
                      <Slider
                        min={24}
                        max={56}
                        step={2}
                        value={[subtitleSize]}
                        onValueChange={([v]) => setSubtitleSize(v)}
                      />
                      <div className="flex justify-between text-xs text-(--muted-fg)">
                        <span>24px</span>
                        <span>56px</span>
                      </div>
                    </div>
                  </TabsContent>

                  {/* Tab: Pipeline settings */}
                  <TabsContent value="clips" className="space-y-5">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>Numero de clips</Label>
                        <span className="font-mono text-sm text-(--accent)">{clipCount}</span>
                      </div>
                      <Slider
                        min={1}
                        max={20}
                        step={1}
                        value={[clipCount]}
                        onValueChange={([v]) => setClipCount(v)}
                      />
                      <div className="flex justify-between text-xs text-(--muted-fg)">
                        <span>1 clip</span>
                        <span>20 clips</span>
                      </div>
                    </div>

                    <Separator />

                    {/* Caption preset selector */}
                    <div className="space-y-3">
                      <Label>Estilo de subtitulos</Label>
                      <div className="grid grid-cols-3 gap-2">
                        {([
                          { id: "hormozi", name: "Hormozi", desc: "Bold, yellow highlight" },
                          { id: "mrbeast", name: "MrBeast", desc: "Massive, red, energetico" },
                          { id: "classic", name: "Clasico", desc: "Blanco con outline" },
                          { id: "neon", name: "Neon", desc: "Glow cyan, gaming" },
                          { id: "minimal", name: "Minimal", desc: "Discreto, con fondo" },
                          { id: "karaoke-pop", name: "Karaoke Pop", desc: "Pop de escala, verde" },
                        ] as const).map(({ id, name, desc }) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setCaptionPreset(id)}
                            className={`rounded-lg border px-3 py-2.5 text-left transition-all ${
                              captionPreset === id
                                ? "border-(--accent) bg-(--accent)/10 ring-1 ring-(--accent)/30"
                                : "border-(--line) bg-(--surface-2) hover:border-(--line-2)"
                            }`}
                          >
                            <p className="text-xs font-semibold">{name}</p>
                            <p className="text-[10px] text-(--muted-fg) mt-0.5">{desc}</p>
                          </button>
                        ))}
                      </div>
                    </div>

                    <Separator />

                    {/* Hook optimizer */}
                    <div className="flex items-center justify-between rounded-lg border border-(--line) bg-(--surface-2) px-4 py-3">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <Zap className="h-3.5 w-3.5 text-(--accent)" />
                          <p className="text-sm font-medium">Hook optimizer</p>
                        </div>
                        <p className="text-xs text-(--muted-fg) mt-0.5">
                          Tecnica Hormozi/MrBeast: muestra el momento mas impactante al inicio del clip para detener el scroll.
                        </p>
                      </div>
                      <Switch checked={hookOptimizer} onCheckedChange={setHookOptimizer} />
                    </div>

                    <div className="rounded-lg border border-(--accent)/20 bg-(--accent)/5 px-4 py-3">
                      <p className="text-sm font-medium">Duracion automatica</p>
                      <p className="text-xs text-(--muted-fg) mt-0.5">
                        La IA determina la duracion optima de cada clip (15s-180s) segun el contenido.
                      </p>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-(--line) bg-(--surface-2) px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">Split-screen automatico</p>
                        <p className="text-xs text-(--muted-fg) mt-0.5">
                          Auto-detecta videos landscape y los divide en dos vistas. Desactiva si no quieres split.
                        </p>
                      </div>
                      <Switch checked={splitScreen} onCheckedChange={setSplitScreen} />
                    </div>
                  </TabsContent>
                </Tabs>

                <Separator />

                <Button
                  type="submit"
                  disabled={!canSubmit}
                  size="lg"
                  className="w-full"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Procesando pipeline...
                    </>
                  ) : (
                    <>
                      <Cpu className="h-4 w-4" />
                      Generar {clipCount} clips virales
                    </>
                  )}
                </Button>

                {!canSubmit && !loading && (
                  <p className="text-center text-xs text-(--muted-fg)">
                    {!video
                      ? "Selecciona un video en la pestana Video para comenzar."
                      : backendReady === false
                        ? "Backend no disponible. Verifica FFmpeg y recarga la pagina."
                        : "Esperando disponibilidad del sistema."}
                  </p>
                )}
              </form>
            </CardContent>
          </Card>

          {/* Right — pipeline status */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Activity className="h-4 w-4 text-(--accent)" />
                  Estado del pipeline
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Status message */}
                <div className="rounded-lg border border-(--line) bg-(--surface-2) px-4 py-3 text-sm">
                  {processingStatus}
                </div>

                {/* Progress */}
                <div className="space-y-2">
                  <div className="flex justify-between text-xs font-mono text-(--muted-fg)">
                    <span>{progressStage}</span>
                    <span>{Math.round(progressValue)}%</span>
                  </div>
                  <Progress value={progressValue} />
                  {loading && (
                    <p className="text-xs text-(--muted-fg)">
                      {etaSeconds !== null
                        ? `ETA: ${formatSeconds(etaSeconds)}`
                        : "Procesando, esto puede tardar unos minutos..."}
                    </p>
                  )}
                </div>

                <Separator />

                {/* Feature indicators */}
                <div className="space-y-2 text-xs">
                  {[
                    { label: "Transcripcion Whisper-1", enabled: true },
                    { label: "Analisis visual GPT-4o Vision", enabled: true },
                    { label: "Deteccion multimodal (audio + video)", enabled: true },
                    { label: `Caption preset: ${captionPreset}`, enabled: true },
                    { label: "Hook optimizer (spoiler hook)", enabled: hookOptimizer },
                    { label: "Thumbnails automaticos", enabled: true },
                    { label: "Hook text overlay", enabled: true },
                    { label: "Zoom dinamico en momentos clave", enabled: true },
                    { label: "Copys multi-plataforma (TikTok/IG/YT)", enabled: true },
                    { label: "Subtitulos karaoke", enabled: true },
                    { label: "Agrupacion inteligente de subtitulos", enabled: true },
                    { label: "Auto-titulo viral", enabled: autoTitle },
                    { label: "Duracion variable por contenido", enabled: true },
                    { label: "Filtro anti-publicidad", enabled: true },
                    { label: "Corte por frase", enabled: true },
                    { label: "Deteccion de escenas", enabled: true },
                    { label: "Scoring multi-dimensional", enabled: true },
                    { label: "Benchmark TikTok", enabled: !!activeBenchmark },
                    { label: "Split-screen auto", enabled: splitScreen },
                  ].map(({ label, enabled }) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className="text-(--muted-fg)">{label}</span>
                      <span
                        className={`font-mono font-medium ${
                          enabled ? "text-(--accent-2)" : "text-(--muted-fg)"
                        }`}
                      >
                        {enabled ? "activo" : "inactivo"}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Error card */}
            {error && (
              <Card className="border-red-500/30 bg-red-500/5">
                <CardContent className="pt-4">
                  <div className="flex gap-3">
                    <XCircle className="h-5 w-5 shrink-0 text-red-400 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-red-400">Error en el pipeline</p>
                      <p className="text-sm text-(--muted-fg) mt-1">{error}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Job diagnostics */}
            {response && (
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-(--accent-2)" />
                    <CardTitle className="text-sm font-mono text-(--muted-fg)">
                      JOB {response.jobId}
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  {response.notes.map((note, i) => (
                    <p key={i} className="text-xs text-(--muted-fg) leading-5">
                      {note}
                    </p>
                  ))}
                </CardContent>
              </Card>
            )}

            {!error && !response && (
              <div className="rounded-xl border border-dashed border-(--line) p-6 text-center text-sm text-(--muted-fg)">
                Los clips apareceran aqui tras el procesamiento.
              </div>
            )}
          </div>
        </div>

        {/* TikTok Analytics — benchmark calibration */}
        <section className="mt-8">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-xl">
                <TrendingUp className="h-5 w-5 text-(--accent)" />
                TikTok Analytics
              </CardTitle>
              <CardDescription>
                Analiza contenido trending y creadores top para calibrar el scoring con datos reales.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Active benchmark indicator */}
              {activeBenchmark && (
                <div className="flex items-center justify-between rounded-lg border border-(--accent-2)/30 bg-(--accent-2)/5 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-(--accent-2)" />
                    <div>
                      <p className="text-sm font-medium text-(--accent-2)">Benchmark activo</p>
                      <p className="text-xs text-(--muted-fg)">
                        {activeBenchmark.source} · {activeBenchmark.benchmark.totalAnalyzed} videos · Engagement: {(activeBenchmark.benchmark.avgEngagementRate * 100).toFixed(1)}%
                      </p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={handleDeactivateBenchmark}>
                    Desactivar
                  </Button>
                </div>
              )}

              <Tabs defaultValue="trending">
                <TabsList className="w-full sm:w-auto">
                  <TabsTrigger value="trending" className="flex items-center gap-1.5">
                    <Search className="h-3.5 w-3.5" />
                    Trending
                  </TabsTrigger>
                  <TabsTrigger value="creator" className="flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5" />
                    Creador
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="trending" className="space-y-3 mt-3">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Buscar trending: podcast, comedia, gaming..."
                      value={tiktokQuery}
                      onChange={(e) => setTiktokQuery(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleTiktokSearch()}
                      disabled={tiktokLoading}
                    />
                    <Button onClick={handleTiktokSearch} disabled={tiktokLoading || !tiktokQuery.trim()}>
                      {tiktokLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-(--muted-fg)">
                    Busca por nicho o keywords para ver que contenido esta funcionando en TikTok ahora mismo.
                  </p>
                </TabsContent>

                <TabsContent value="creator" className="space-y-3 mt-3">
                  <div className="flex gap-2">
                    <Input
                      placeholder="@username del creador"
                      value={tiktokCreator}
                      onChange={(e) => setTiktokCreator(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleTiktokCreator()}
                      disabled={tiktokLoading}
                    />
                    <Button onClick={handleTiktokCreator} disabled={tiktokLoading || !tiktokCreator.trim()}>
                      {tiktokLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-(--muted-fg)">
                    Analiza los videos de un creador top en tu nicho para aprender que les funciona.
                  </p>
                </TabsContent>
              </Tabs>

              {tiktokError && (
                <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">
                  <XCircle className="h-4 w-4 shrink-0" />
                  {tiktokError}
                </div>
              )}

              {/* Benchmark results */}
              {tiktokBenchmark && tiktokBenchmark.totalAnalyzed > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold flex items-center gap-1.5">
                      <BarChart3 className="h-4 w-4 text-(--accent)" />
                      Benchmark: {tiktokSource}
                    </h3>
                    <Button size="sm" onClick={handleActivateBenchmark}>
                      <Zap className="mr-1 h-3.5 w-3.5" />
                      Activar benchmark
                    </Button>
                  </div>

                  {/* Key metrics */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { label: "Views promedio", value: tiktokBenchmark.avgViews.toLocaleString() },
                      { label: "Likes promedio", value: tiktokBenchmark.avgLikes.toLocaleString() },
                      { label: "Shares promedio", value: tiktokBenchmark.avgShares.toLocaleString() },
                      { label: "Engagement", value: `${(tiktokBenchmark.avgEngagementRate * 100).toFixed(1)}%` },
                    ].map(({ label, value }) => (
                      <div key={label} className="rounded-lg border border-(--line) bg-(--surface-2) px-3 py-2.5 text-center">
                        <p className="text-xs text-(--muted-fg)">{label}</p>
                        <p className="text-lg font-bold font-mono text-(--accent)">{value}</p>
                      </div>
                    ))}
                  </div>

                  {/* Duration buckets */}
                  {tiktokBenchmark.durationBuckets.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-(--muted-fg)">Duracion vs Performance</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {tiktokBenchmark.durationBuckets.map((b) => {
                          const maxViews = Math.max(...tiktokBenchmark.durationBuckets.map((x) => x.avgViews));
                          const isTop = b.avgViews === maxViews;
                          return (
                            <div
                              key={b.range}
                              className={`rounded-lg border px-3 py-2 text-center ${
                                isTop
                                  ? "border-(--accent)/50 bg-(--accent)/10"
                                  : "border-(--line) bg-(--surface-2)"
                              }`}
                            >
                              <p className="text-xs font-semibold">{b.range}</p>
                              <p className={`text-sm font-mono font-bold ${isTop ? "text-(--accent)" : ""}`}>
                                {b.avgViews.toLocaleString()} views
                              </p>
                              <p className="text-[10px] text-(--muted-fg)">{b.count} videos</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Top videos */}
                  {tiktokVideos.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-(--muted-fg)">Top videos encontrados</p>
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {tiktokVideos.slice(0, 8).map((v) => (
                          <div
                            key={v.id}
                            className="flex items-center justify-between rounded-lg border border-(--line) bg-(--surface-2) px-3 py-2 text-xs"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium">{v.title || "Sin titulo"}</p>
                              <p className="text-(--muted-fg)">
                                @{v.author} · {v.duration}s
                              </p>
                            </div>
                            <div className="flex items-center gap-3 ml-3 shrink-0 font-mono text-(--muted-fg)">
                              <span>{v.playCount.toLocaleString()} views</span>
                              <span>{v.likeCount.toLocaleString()} likes</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Clips grid — full width */}
        {response && response.clips.length > 0 && (
          <section className="mt-10 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold">
                  {response.clips.length} clips listos
                </h2>
                <p className="text-sm text-(--muted-fg) mt-1">
                  Formato vertical 1080x1920 · optimizados para YouTube Shorts, TikTok e Instagram Reels
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="success" className="font-mono">
                  {response.clips.filter((c) => c.hasSubtitles).length}/{response.clips.length} subtitulos
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => (window.location.href = `/editor?jobId=${encodeURIComponent(response.jobId)}`)}
                >
                  <Pencil className="mr-1 h-3.5 w-3.5" /> Editar clips
                </Button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {response.clips.map((clip, i) => (
                <div
                  key={clip.fileName}
                  className="group overflow-hidden rounded-xl border border-(--line) bg-(--surface) transition-all hover:border-(--line-2) hover:shadow-[0_0_0_1px_rgba(124,58,237,0.2)]"
                >
                  {/* 9:16 player with thumbnail poster */}
                  <div className="relative aspect-9/16 w-full bg-black">
                    <video
                      controls
                      preload="metadata"
                      className="absolute inset-0 h-full w-full object-contain"
                      src={clip.url}
                      poster={clip.thumbnailUrl || undefined}
                    />
                    {clip.hookApplied && (
                      <div className="absolute top-2 left-2">
                        <Badge className="bg-yellow-500/90 text-black text-[10px] font-bold border-0">
                          <Zap className="mr-0.5 h-3 w-3" /> HOOK
                        </Badge>
                      </div>
                    )}
                  </div>

                  {/* Metadata */}
                  <div className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-sm truncate" title={clip.title}>
                        {clip.title || `Clip ${i + 1}`}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {clip.hasSubtitles && (
                          <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                            SUB
                          </Badge>
                        )}
                        {clip.overallScore > 0 && (
                          <Badge variant="accent" className="font-mono text-[10px] py-0 px-1.5">
                            {clip.overallScore}/100
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Multi-dimensional scores */}
                    {clip.overallScore > 0 && (
                      <div className="grid grid-cols-4 gap-1 text-[10px]">
                        {(
                          [
                            { key: "hook" as const, label: "Hook" },
                            { key: "flow" as const, label: "Flow" },
                            { key: "engagement" as const, label: "Engage" },
                            { key: "completeness" as const, label: "Compl" },
                          ] as const
                        ).map(({ key, label }) => {
                          const v = clip.scores[key];
                          const color =
                            v >= 80
                              ? "text-(--accent-2)"
                              : v >= 60
                                ? "text-yellow-400"
                                : "text-(--muted-fg)";
                          return (
                            <div key={key} className="text-center">
                              <span className="text-(--muted-fg) block">{label}</span>
                              <span className={`font-mono font-bold ${color}`}>{v}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <p className="font-mono text-xs text-(--muted-fg)">
                      {formatSeconds(clip.startSeconds)} &rarr;{" "}
                      {formatSeconds(clip.startSeconds + clip.durationSeconds)}
                      &nbsp;&middot;&nbsp;
                      {clip.durationSeconds.toFixed(0)}s
                    </p>

                    {clip.hookText && (
                      <div className="flex items-center gap-1.5">
                        <Badge className="bg-yellow-500/90 text-black text-[10px] font-bold border-0 shrink-0">
                          HOOK
                        </Badge>
                        <span className="text-xs font-bold truncate">{clip.hookText}</span>
                      </div>
                    )}

                    {clip.rationale && (
                      <p className="text-xs text-(--muted-fg) leading-5 line-clamp-2">
                        {clip.rationale}
                      </p>
                    )}

                    {/* Platform descriptions */}
                    {(clip.descriptions?.tiktok || clip.descriptions?.instagram || clip.descriptions?.youtube) && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-(--muted-fg) hover:text-(--foreground) transition-colors">
                          Copys por plataforma
                        </summary>
                        <div className="mt-2 space-y-1.5 pl-1">
                          {clip.descriptions.tiktok && (
                            <div>
                              <span className="font-semibold text-(--accent)">TikTok:</span>{" "}
                              <span className="text-(--muted-fg)">{clip.descriptions.tiktok}</span>
                            </div>
                          )}
                          {clip.descriptions.instagram && (
                            <div>
                              <span className="font-semibold text-pink-500">Instagram:</span>{" "}
                              <span className="text-(--muted-fg)">{clip.descriptions.instagram}</span>
                            </div>
                          )}
                          {clip.descriptions.youtube && (
                            <div>
                              <span className="font-semibold text-red-500">YouTube:</span>{" "}
                              <span className="text-(--muted-fg)">{clip.descriptions.youtube}</span>
                            </div>
                          )}
                        </div>
                      </details>
                    )}

                    <Button asChild variant="secondary" size="sm" className="w-full">
                      <a href={clip.url} download className="flex items-center gap-1.5">
                        <Download className="h-3.5 w-3.5" />
                        Descargar MP4
                      </a>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Previous jobs history */}
        {previousJobs.length > 0 && (
          <section className="mt-10 space-y-4">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-(--muted-fg)" />
              <h2 className="text-lg font-semibold">Jobs anteriores</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {previousJobs.map((job) => (
                <div
                  key={job.jobId}
                  className="flex items-center justify-between rounded-lg border border-(--line) bg-(--surface) px-4 py-3 hover:border-(--line-2) transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{job.sourceFileName}</p>
                    <p className="text-xs text-(--muted-fg) mt-0.5">
                      {job.clipCount} clips · {new Date(job.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 ml-3 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => (window.location.href = `/editor?jobId=${encodeURIComponent(job.jobId)}`)}
                    >
                      <Pencil className="mr-1 h-3 w-3" /> Editar
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 text-(--muted-fg) hover:text-red-400 hover:border-red-400/50"
                      onClick={async () => {
                        if (!confirm(`Eliminar job "${job.sourceFileName}" y todos sus clips?`)) return;
                        try {
                          await fetch(`/api/job/${encodeURIComponent(job.jobId)}`, { method: "DELETE" });
                          setPreviousJobs((prev) => prev.filter((j) => j.jobId !== job.jobId));
                        } catch { /* ignore */ }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
