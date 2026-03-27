"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

type PlatformReport = {
  platform: "tiktok" | "youtube" | "facebook";
  status: "ok" | "partial" | "unavailable";
  handle: string;
  profileUrl: string;
  note?: string;
  profile?: {
    name: string;
    followers: number;
    totalViews: number;
    videoCount: number;
    verified: boolean;
    avatarUrl?: string;
  };
  metrics?: {
    avgViews: number;
    avgEngagementRate: number;
    bestDuration: string;
    totalAnalyzed: number;
  };
  topVideos: Array<{
    id: string;
    title: string;
    views: number;
    engagementRate: number;
    durationSeconds: number;
    url: string;
    publishedText?: string;
  }>;
  timeline: Array<{
    date: string;
    views: number;
    videos: number;
  }>;
};

type DashboardResponse = {
  generatedAt: string;
  strategySource: "ai" | "heuristic";
  global: {
    avgViewsCrossPlatform: number;
    tiktokEngagement: string;
    tiktokStatus: string;
    youtubeStatus: string;
    facebookStatus: string;
  };
  connectors: Array<{
    platform: "tiktok" | "youtube" | "facebook";
    provider: string;
    host: string;
    status: "ok" | "partial" | "unavailable";
    note: string;
  }>;
  accounts: {
    tiktok: PlatformReport;
    youtube: PlatformReport;
    facebook: PlatformReport;
  };
  strategy: {
    summary: string;
    actions: string[];
    experiments: string[];
    compliance: string[];
  };
  cache?: {
    source: "live" | "cache" | "stale-fallback";
    ageSeconds: number;
    ttlSeconds: number;
    forced: boolean;
  };
};

function fmt(n: number) {
  return n.toLocaleString("es-CL");
}

function platformLabel(platform: PlatformReport["platform"]) {
  if (platform === "tiktok") return "TikTok";
  if (platform === "youtube") return "YouTube";
  return "Facebook";
}

function platformBarClass(platform: PlatformReport["platform"]) {
  if (platform === "tiktok") return "bg-emerald-500";
  if (platform === "youtube") return "bg-red-500";
  return "bg-sky-500";
}

function shortDate(date: string) {
  const parts = date.split("-");
  if (parts.length !== 3) return date;
  return `${parts[2]}/${parts[1]}`;
}

function validTimeline(account: PlatformReport) {
  return [...(account.timeline ?? [])]
    .filter((point) => point.views > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-10);
}

function statusBadge(status: PlatformReport["status"]) {
  if (status === "ok") return <Badge variant="success">Conectado</Badge>;
  if (status === "partial") return <Badge variant="outline">Parcial</Badge>;
  return <Badge variant="outline">No disponible</Badge>;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forcing, setForcing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (force = false) => {
    if (force) setForcing(true);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/overview${force ? "?refresh=1" : ""}`, { cache: "no-store" });
      const payload = (await res.json()) as DashboardResponse | { error?: string };
      if (!res.ok) {
        throw new Error("error" in payload ? payload.error || "Error cargando dashboard." : "Error cargando dashboard.");
      }
      setData(payload as DashboardResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error cargando dashboard.");
    } finally {
      if (force) setForcing(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="grain min-h-screen">
      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-8">
        <TopNav />

        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold tracking-tight">
              Centro de <span className="text-(--accent)">rendimiento</span>
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-(--muted-fg)">
              Monitorea tus cuentas, detecta patrones de viralidad y transforma esos aprendizajes en decisiones de clip.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Actualizar
            </Button>
            <Button variant="ghost" onClick={() => void load(true)} disabled={loading || forcing}>
              {forcing ? "Forzando..." : "Forzar API"}
            </Button>
          </div>
        </div>

        {error && (
          <Card className="mb-6 border-red-500/30 bg-red-500/5">
            <CardContent className="pt-4 text-sm text-red-400">{error}</CardContent>
          </Card>
        )}

        {loading && !data && (
          <Card>
            <CardContent className="py-10 text-center text-sm text-(--muted-fg)">
              Cargando datos de plataformas...
            </CardContent>
          </Card>
        )}

        {data && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Views promedio cross-platform</CardDescription>
                  <CardTitle className="text-2xl font-mono">{fmt(data.global.avgViewsCrossPlatform)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Engagement TikTok</CardDescription>
                  <CardTitle className="text-2xl font-mono">{data.global.tiktokEngagement}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Fuente de estrategia</CardDescription>
                  <CardTitle className="text-xl flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-(--accent)" />
                    {data.strategySource === "ai" ? "OpenAI" : "Heuristica"}
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Ultima actualizacion</CardDescription>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Clock3 className="h-4 w-4 text-(--muted-fg)" />
                    {new Date(data.generatedAt).toLocaleString()}
                  </CardTitle>
                  <CardDescription className="pt-1">
                    {data.cache?.source === "cache" && `Cache activo (${Math.round((data.cache.ageSeconds || 0) / 60)} min de antiguedad)`}
                    {data.cache?.source === "live" && "Datos recien consultados"}
                    {data.cache?.source === "stale-fallback" && "Mostrando snapshot previo por limite de API"}
                  </CardDescription>
                </CardHeader>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-(--accent)" />
                  Plan de 7 dias
                </CardTitle>
                <CardDescription>{data.strategy.summary}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div>
                  <p className="font-semibold mb-2">Acciones inmediatas</p>
                  <ul className="space-y-1.5 text-(--muted-fg)">
                    {data.strategy.actions.map((item, i) => (
                      <li key={i}>• {item}</li>
                    ))}
                  </ul>
                </div>
                <Separator />
                <div>
                  <p className="font-semibold mb-2">Experimentos</p>
                  <ul className="space-y-1.5 text-(--muted-fg)">
                    {data.strategy.experiments.map((item, i) => (
                      <li key={i}>• {item}</li>
                    ))}
                  </ul>
                </div>
                <Separator />
                <div>
                  <p className="font-semibold mb-2 flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4 text-(--accent-2)" />
                    Compliance
                  </p>
                  <ul className="space-y-1.5 text-(--muted-fg)">
                    {data.strategy.compliance.map((item, i) => (
                      <li key={i}>• {item}</li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-4">
              {[data.accounts.tiktok, data.accounts.youtube, data.accounts.facebook].map((account) => (
                <Card key={account.platform} className="w-full">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <CardTitle className="text-lg uppercase">{account.platform}</CardTitle>
                        <CardDescription className="truncate mt-1">
                          <a href={account.profileUrl} target="_blank" rel="noreferrer" className="hover:underline">
                            {account.handle}
                          </a>
                        </CardDescription>
                      </div>
                      {statusBadge(account.status)}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4 text-sm">
                    {account.profile ? (
                      <div className="grid gap-2 rounded-lg border border-(--line) bg-(--surface-2) p-3 sm:grid-cols-2 lg:grid-cols-5">
                        <div>
                          <p className="text-[11px] text-(--muted-fg)">Followers</p>
                          <p className="font-mono font-semibold">{fmt(account.profile.followers)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-(--muted-fg)">Videos</p>
                          <p className="font-mono font-semibold">{fmt(account.profile.videoCount)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-(--muted-fg)">Views total</p>
                          <p className="font-mono font-semibold">{fmt(account.profile.totalViews)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-(--muted-fg)">Verificado</p>
                          <p className="font-semibold flex items-center gap-1">
                            {account.profile.verified ? (
                              <>
                                <CheckCircle2 className="h-3.5 w-3.5 text-(--accent-2)" /> Si
                              </>
                            ) : (
                              <>
                                <AlertTriangle className="h-3.5 w-3.5 text-yellow-400" /> No
                              </>
                            )}
                          </p>
                        </div>
                        <div>
                          <p className="text-[11px] text-(--muted-fg)">Promedio de views</p>
                          <p className="font-mono font-semibold text-(--accent)">
                            {fmt(account.metrics?.avgViews ?? 0)}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-(--line) bg-(--surface-2) p-3 text-(--muted-fg)">
                        {account.note || "Sin datos de perfil."}
                      </div>
                    )}

                    <div className="rounded-lg border border-(--line) bg-(--surface-2) p-3">
                      <div className="mb-3 flex items-center justify-between gap-2 text-[11px] text-(--muted-fg)">
                        <span>{platformLabel(account.platform)} · Impacto por fecha (views por dia)</span>
                        <span className="font-mono">ultimos 10 dias con datos</span>
                      </div>
                      {(() => {
                        const points = validTimeline(account);
                        if (points.length === 0) {
                          return (
                            <div className="rounded-md border border-dashed border-(--line) p-3">
                              <p className="text-xs text-(--muted-fg)">
                                Sin data temporal suficiente para graficar en esta plataforma.
                              </p>
                            </div>
                          );
                        }

                        const maxViews = Math.max(...points.map((point) => point.views), 1);
                        return (
                          <div className="overflow-x-auto">
                            <div className="min-w-[620px]">
                              <div className="h-[230px] border-b border-(--line) px-2">
                                <div className="flex h-full items-end gap-3">
                                  {points.map((point) => {
                                    const barHeight = Math.max(16, Math.round((point.views / maxViews) * 180));
                                    return (
                                      <div key={`${account.platform}-${point.date}`} className="flex min-w-[52px] flex-1 flex-col items-center">
                                        <span className="mb-1 text-[10px] font-mono text-(--muted-fg)">{fmt(point.views)}</span>
                                        <div
                                          className={`w-9 rounded-t-sm ${platformBarClass(account.platform)}`}
                                          style={{ height: `${barHeight}px` }}
                                        />
                                        <span className="mt-1 text-[10px] text-(--muted-fg)">{shortDate(point.date)}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    {account.note && (
                      <p className="text-[11px] text-(--muted-fg)">{account.note}</p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <BarChart3 className="h-4 w-4 text-(--accent)" />
                  Estado de conectores
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-(--muted-fg) space-y-1.5">
                {(data.connectors ?? []).map((connector) => (
                  <p key={`${connector.platform}-${connector.provider}`}>
                    {connector.platform.toUpperCase()}: {connector.provider} ({connector.host}) · {connector.status} · {connector.note}
                  </p>
                ))}
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
