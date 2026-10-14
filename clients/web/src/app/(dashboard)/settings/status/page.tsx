"use client";

/**
 * System status screen: infrastructure health, engagement statistics and the
 * agent registry — everything the former single settings page showed read-only.
 *
 * It reads the three collection endpoints directly and never touches
 * `/api/settings`, so opening it cannot disturb an unsaved settings draft
 * elsewhere in the console.
 */

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Database, Server, Network, Bot, Box, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n-context";
import type { TranslationKey } from "@/lib/i18n";
import type { AgentConfig } from "@/lib/agents";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";
import {
  type EngagementSummary,
  isAgentConfig,
  isEngagementSummary,
  readCollectionResponse,
} from "@/lib/settings-data";

interface ServiceStatus {
  name: string;
  status: "ok" | "error" | "loading";
  /** Server-reported detail; empty means "use the status wording". */
  detail: string;
  icon: typeof Server;
}

function StatusDot({ status }: { status: "ok" | "error" | "loading" }) {
  if (status === "loading") return <Loader2 className="h-3 w-3 animate-spin text-amber-400" />;
  if (status === "ok") return <div className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />;
  return <div className="h-2.5 w-2.5 rounded-full bg-red-400 shadow-sm shadow-red-400/50" />;
}

const SERVICE_NAME_MAP: Record<string, string> = {
  langgraph: "LangGraph API",
  litellm: "LiteLLM Proxy",
  neo4j: "Neo4j",
  postgres: "PostgreSQL",
};

const SERVICE_DETAIL_KEYS: Record<"loading" | "ok" | "error", TranslationKey> = {
  loading: "settings.health.checking",
  ok: "settings.health.connected",
  error: "settings.health.unreachable",
};

export default function StatusSettingsPage(): React.ReactNode {
  const { t } = useI18n();
  const [services, setServices] = useState<ServiceStatus[]>([
    { name: "LangGraph API", status: "loading", detail: "", icon: Activity },
    { name: "LiteLLM Proxy", status: "loading", detail: "", icon: Server },
    { name: "Neo4j", status: "loading", detail: "", icon: Network },
    { name: "PostgreSQL", status: "ok", detail: "", icon: Database },
    { name: "Sandbox", status: "ok", detail: "decepticon-sandbox", icon: Box },
  ]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [engagements, setEngagements] = useState<EngagementSummary[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingEngagements, setLoadingEngagements] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [engagementsError, setEngagementsError] = useState<string | null>(null);

  // Check all services via server-side health API
  useEffect(() => {
    let active = true;
    fetch("/api/health", { signal: AbortSignal.timeout(10000) })
      .then(async (res) => {
        if (!active) return;
        if (!res.ok) throw new Error("Health API failed");
        const data = await res.json();
        if (!active) return;
        setServices((prev) =>
          prev.map((s) => {
            const match = (data.services ?? []).find(
              (r: { name: string }) => SERVICE_NAME_MAP[r.name] === s.name
            );
            if (match) return { ...s, status: match.status as "ok" | "error", detail: match.detail ?? "" };
            return s;
          })
        );
      })
      .catch(() => {
        if (!active) return;
        setServices((prev) =>
          prev.map((s) => s.status === "loading" ? { ...s, status: "error" as const, detail: "" } : s)
        );
      });
    return () => { active = false; };
  }, []);

  // Fetch agents
  useEffect(() => {
    let active = true;
    setAgentsError(null);
    fetch("/api/agents")
      .then((res) => readCollectionResponse(res, "Agents", isAgentConfig))
      .then((data) => { if (active) setAgents(data); })
      .catch((error: unknown) => {
        if (active) {
          setAgents([]);
          setAgentsError(error instanceof Error ? error.message : "Agents request failed");
        }
      })
      .finally(() => { if (active) setLoadingAgents(false); });
    return () => { active = false; };
  }, []);

  // Fetch engagements
  useEffect(() => {
    let active = true;
    setEngagementsError(null);
    fetch("/api/engagements")
      .then((res) => readCollectionResponse(res, "Engagements", isEngagementSummary))
      .then((data) => { if (active) setEngagements(data); })
      .catch((error: unknown) => {
        if (active) {
          setEngagements([]);
          setEngagementsError(error instanceof Error ? error.message : "Engagements request failed");
        }
      })
      .finally(() => { if (active) setLoadingEngagements(false); });
    return () => { active = false; };
  }, []);

  const statusCounts = {
    total: engagements.length,
    running: engagements.filter((e) => e.status === "running").length,
    completed: engagements.filter((e) => e.status === "completed").length,
    draft: engagements.filter((e) => e.status === "draft").length,
    planning: engagements.filter((e) => e.status === "planning").length,
  };

  return (
    <SettingsPageShell titleKey="settings.page.status.title" subtitleKey="settings.page.status.subtitle">
      {/* System Health */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Server className="h-4 w-4" />
            {t("settings.health.title")}
          </CardTitle>
          <CardDescription>{t("settings.health.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {services.map((svc) => (
              <div key={svc.name} className="flex items-center gap-3 rounded-lg border border-border/50 p-3">
                <StatusDot status={svc.status} />
                <svc.icon className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{svc.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {svc.detail || t(SERVICE_DETAIL_KEYS[svc.status])}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Engagement Stats */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.stats.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingEngagements ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : engagementsError ? (
            <p role="status" className="py-6 text-center text-sm text-red-400">
              {engagementsError}
            </p>
          ) : (
            <div className="grid grid-cols-5 gap-4 text-center">
              {([
                ["settings.stats.total", statusCounts.total, "text-foreground"],
                ["settings.stats.running", statusCounts.running, "text-amber-400"],
                ["settings.stats.completed", statusCounts.completed, "text-emerald-400"],
                ["settings.stats.planning", statusCounts.planning, "text-violet-400"],
                ["settings.stats.draft", statusCounts.draft, "text-zinc-400"],
              ] as const).map(([labelKey, count, color]) => (
                <div key={labelKey}>
                  <p className={cn("text-2xl font-bold", color)}>{count}</p>
                  <p className="text-xs text-muted-foreground">{t(labelKey)}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Agent Registry */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bot className="h-4 w-4" />
            {t("settings.agents.title")}
          </CardTitle>
          <CardDescription>{t("settings.agents.subtitle", { count: agents.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingAgents ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : agentsError ? (
            <p role="status" className="py-6 text-center text-sm text-red-400">
              {agentsError}
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent) => (
                <div key={agent.id} className="flex items-center gap-3 rounded-lg border border-border/50 p-3">
                  <div
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: agent.color }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{agent.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{agent.description}</p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {agent.role}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </SettingsPageShell>
  );
}
