"use client";

import { useEffect, useRef, useState } from "react";
import type { SubagentCustomEvent } from "@decepticon/streaming";
import { AGENT_DISPLAY_CONFIG } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n-context";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Bot,
  CheckCircle,
  CheckCircle2,
  Wrench,
  MessageSquare,
  HelpCircle,
  Target,
  Clock,
  XCircle,
  Loader2,
  FolderOpen,
  Activity,
  Terminal,
  Rocket,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────

interface LiveActivityFeedProps {
  events: SubagentCustomEvent[];
  engagementId: string;
  className?: string;
}

interface Objective {
  id: string;
  title: string;
  status: string;
  phase: string;
  owner?: string;
}

interface FileEntry {
  name: string;
  folder: string;
  path: string;
  size: number;
}

// ── Helpers ──────────────────────────────────────────────────────

function getAgentColor(agentId: string): string {
  return AGENT_DISPLAY_CONFIG[agentId]?.color ?? "#6b7280";
}

function getAgentName(agentId: string): string {
  return AGENT_DISPLAY_CONFIG[agentId]?.name ?? agentId;
}

function formatRelativeTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args) return "";
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const parts = keys.slice(0, 2).map((k) => {
    const v = args[k];
    const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
    return `${k}: ${s.length > 30 ? s.slice(0, 30) + "…" : s}`;
  });
  if (keys.length > 2) parts.push("…");
  return parts.join(", ");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const OBJ_STATUS_ICON: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  completed: { icon: CheckCircle2, color: "text-emerald-400" },
  "in-progress": { icon: Loader2, color: "text-amber-400" },
  blocked: { icon: XCircle, color: "text-red-400" },
  pending: { icon: Clock, color: "text-zinc-600" },
  cancelled: { icon: XCircle, color: "text-zinc-600" },
};

// ── Event Row ────────────────────────────────────────────────────

interface EventRowProps {
  event: SubagentCustomEvent;
  relativeTime: string;
}

function EventRow({ event, relativeTime }: EventRowProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const color = getAgentColor(event.agent);
  const name = getAgentName(event.agent);

  let icon: React.ReactNode;
  let detail: React.ReactNode;
  let rowClass = "";

  switch (event.type) {
    case "subagent_start": {
      icon = <Bot className="h-3.5 w-3.5 shrink-0 text-emerald-400" />;
      detail = (
        <span className="text-emerald-400/90">
          {t("activity.agent.started", { name })}
          {event.content ? <span className="text-zinc-500"> — {event.content}</span> : null}
        </span>
      );
      break;
    }
    case "subagent_end": {
      const isError = !!event.error;
      icon = <CheckCircle className={cn("h-3.5 w-3.5 shrink-0", isError ? "text-red-400" : "text-zinc-500")} />;
      detail = (
        <span className={isError ? "text-red-400" : "text-zinc-500"}>
          {t(isError ? "activity.agent.failed" : "activity.agent.completed", { name })}
          {event.elapsed != null ? ` (${event.elapsed.toFixed(1)}s)` : ""}
        </span>
      );
      if (isError) rowClass = "bg-red-500/5";
      break;
    }
    case "subagent_tool_call": {
      const argsSummary = summarizeArgs(event.args);
      icon = <Wrench className="h-3.5 w-3.5 shrink-0 text-amber-400" />;
      detail = (
        <span className="text-amber-300/90">
          {name} → <span className="font-mono text-amber-400">{event.tool}</span>
          {argsSummary ? <span className="text-zinc-500">({argsSummary})</span> : null}
        </span>
      );
      break;
    }
    case "subagent_tool_result": {
      icon = <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-zinc-600" />;
      detail = (
        <span className="text-zinc-500">
          {name} ← <span className="font-mono">{event.tool}</span> {t("activity.toolDone")}
        </span>
      );
      break;
    }
    case "subagent_message": {
      const text = event.content ?? event.text ?? "";
      const truncated = text.length > 200 && !expanded;
      icon = <MessageSquare className="h-3.5 w-3.5 shrink-0 text-zinc-400" />;
      detail = (
        <span className="text-zinc-300">
          {name}:{" "}
          <span className="text-zinc-400">{truncated ? text.slice(0, 200) + "…" : text}</span>
          {text.length > 200 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
              className="ml-1 text-[10px] text-zinc-600 hover:text-zinc-400"
            >
              {t(expanded ? "activity.collapse" : "activity.expand")}
            </button>
          )}
        </span>
      );
      break;
    }
    case "ask_user_question": {
      icon = <HelpCircle className="h-3.5 w-3.5 shrink-0 animate-pulse text-amber-400" />;
      detail = (
        <span className="text-amber-300 animate-pulse">
          {t("activity.agent.waiting", { name, question: event.question ?? event.content ?? "…" })}
        </span>
      );
      rowClass = "bg-amber-500/5";
      break;
    }
    case "background_complete": {
      const exit = event.exit_code;
      const ok = exit === 0 || exit == null;
      const label = event.command ?? event.session ?? t("activity.backgroundTask");
      icon = <Terminal className={cn("h-3.5 w-3.5 shrink-0", ok ? "text-emerald-400" : "text-red-400")} />;
      detail = (
        <span className={ok ? "text-zinc-300" : "text-red-300"}>
          {exit != null
            ? t("activity.agent.exited", { name, label, code: exit })
            : t("activity.agent.finished", { name, label })}
        </span>
      );
      if (!ok) rowClass = "bg-red-500/5";
      break;
    }
    case "engagement_ready": {
      icon = <Rocket className="h-3.5 w-3.5 shrink-0 text-violet-400" />;
      detail = (
        <span className="text-violet-300">{t("activity.engagementReady")}</span>
      );
      rowClass = "bg-violet-500/5";
      break;
    }
    case "planning_draft_ready": {
      icon = <Rocket className="h-3.5 w-3.5 shrink-0 text-violet-400" />;
      detail = <span className="text-violet-300">{t("activity.planningDraftReady")}</span>;
      rowClass = "bg-violet-500/5";
      break;
    }
    default: {
      icon = <Bot className="h-3.5 w-3.5 shrink-0 text-zinc-600" />;
      detail = <span className="text-zinc-500">{name}: {event.type}</span>;
    }
  }

  return (
    <div className={cn("flex min-h-8 items-center gap-2 border-b border-white/[0.04] px-3 py-1 text-[11px] leading-tight", rowClass)}>
      <span className="w-12 shrink-0 text-right text-[10px] text-zinc-600">{relativeTime}</span>
      <Badge
        variant="outline"
        className="h-4 shrink-0 border-0 px-1.5 text-[10px] font-medium"
        style={{ backgroundColor: color + "18", color }}
      >
        {name}
      </Badge>
      {icon}
      <span className="min-w-0 flex-1 truncate text-[11px]">{detail}</span>
    </div>
  );
}

// ── Idle State — shows OPPLAN + workspace when no events ─────────

function IdleState({ engagementId }: { engagementId: string }) {
  const { t } = useI18n();
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [opplanRes, engRes] = await Promise.all([
          fetch(`/api/engagements/${engagementId}/opplan`).catch(() => null),
          fetch(`/api/engagements/${engagementId}`).catch(() => null),
        ]);

        if (!active) return;

        if (opplanRes?.ok) {
          const data = await opplanRes.json();
          setObjectives(data.objectives ?? []);
        }

        if (engRes?.ok) {
          const eng = await engRes.json();
          const name = eng.workspacePath?.split("/").pop() ?? eng.name;
          if (name) {
            const filesRes = await fetch(`/api/workspace/${encodeURIComponent(name)}/files`).catch(() => null);
            if (filesRes?.ok && active) {
              const fData = await filesRes.json();
              const allFiles = (fData.folders ?? []).flatMap((f: { files: FileEntry[] }) => f.files);
              setFiles(allFiles);
            }
          }
        }
      } catch { /* ignore */ }
      finally { if (active) setLoading(false); }
    }
    load();
    // Refresh every 10s for live updates
    const interval = setInterval(load, 10000);
    return () => { active = false; clearInterval(interval); };
  }, [engagementId]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-zinc-600" />
      </div>
    );
  }

  const completed = objectives.filter((o) => o.status === "completed").length;
  const inProgress = objectives.filter((o) => o.status === "in-progress").length;
  const blocked = objectives.filter((o) => o.status === "blocked").length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/[0.08] px-3 py-2">
        <Activity className="h-3.5 w-3.5 text-zinc-500" />
        <span className="text-[11px] font-medium text-zinc-400">{t("activity.status")}</span>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-3 p-3">
          {/* OPPLAN objectives */}
          {objectives.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5">
                <Target className="h-3 w-3 text-zinc-500" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  {t("activity.objectives")}
                </span>
                <span className="ml-auto text-[10px] text-zinc-600">
                  {completed}/{objectives.length}
                </span>
              </div>

              {/* Progress bar */}
              <div className="mb-2 h-1 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                  style={{ width: `${objectives.length > 0 ? (completed / objectives.length) * 100 : 0}%` }}
                />
              </div>

              <div className="space-y-1">
                {objectives.map((obj) => {
                  const cfg = OBJ_STATUS_ICON[obj.status] ?? OBJ_STATUS_ICON.pending;
                  const Icon = cfg.icon;
                  return (
                    <div key={obj.id} className="flex items-center gap-2 rounded px-2 py-1 text-[11px]">
                      <Icon className={cn("h-3 w-3 shrink-0", cfg.color, obj.status === "in-progress" && "animate-spin")} />
                      <span className="text-[10px] font-mono text-zinc-600">{obj.id}</span>
                      <span className={cn("flex-1 truncate", obj.status === "in-progress" ? "text-zinc-200" : "text-zinc-400")}>
                        {obj.title}
                      </span>
                      {obj.owner && (
                        <Badge variant="outline" className="h-3.5 border-0 px-1 text-[9px]" style={{ backgroundColor: getAgentColor(obj.owner) + "18", color: getAgentColor(obj.owner) }}>
                          {obj.owner}
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Summary */}
              <div className="mt-2 flex gap-3 text-[10px] text-zinc-600">
                {inProgress > 0 && <span className="text-amber-400">{t("activity.running", { count: inProgress })}</span>}
                {blocked > 0 && <span className="text-red-400">{t("activity.blocked", { count: blocked })}</span>}
                {completed > 0 && <span className="text-emerald-400">{t("activity.done", { count: completed })}</span>}
              </div>
            </div>
          )}

          {/* Workspace files */}
          {files.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5">
                <FolderOpen className="h-3 w-3 text-zinc-500" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  {t("activity.workspaceFiles")}
                </span>
                <span className="ml-auto text-[10px] text-zinc-600">{files.length}</span>
              </div>
              <div className="space-y-0.5">
                {files.slice(0, 15).map((f) => (
                  <div key={f.path} className="flex items-center gap-2 rounded px-2 py-0.5 text-[11px]">
                    <span className="text-[10px] text-zinc-600">{f.folder}/</span>
                    <span className="flex-1 truncate text-zinc-400">{f.name}</span>
                    <span className="text-[10px] text-zinc-700">{formatSize(f.size)}</span>
                  </div>
                ))}
                {files.length > 15 && (
                  <span className="block px-2 text-[10px] text-zinc-700">{t("activity.more", { count: files.length - 15 })}</span>
                )}
              </div>
            </div>
          )}

          {/* Empty state */}
          {objectives.length === 0 && files.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Activity className="mb-2 h-6 w-6 text-zinc-700" />
              <p className="text-xs text-zinc-500">{t("activity.empty")}</p>
              <p className="mt-1 text-[10px] text-zinc-700">
                {t("activity.emptyHint")}
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── LiveActivityFeed ─────────────────────────────────────────────

export function LiveActivityFeed({ events, engagementId, className }: LiveActivityFeedProps) {
  const { t } = useI18n();
  const bottomRef = useRef<HTMLDivElement>(null);
  const timestampsRef = useRef<number[]>([]);
  const [relTimes, setRelTimes] = useState<string[]>([]);

  // Write arrival timestamps to ref — mutation only, never read during render
  useEffect(() => {
    const ts = timestampsRef.current;
    if (events.length > ts.length) {
      const now = Date.now();
      for (let i = ts.length; i < events.length; i++) ts.push(now);
    }
  }, [events.length]);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  // Recompute relative times via timer — async setState, avoids set-state-in-effect
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setRelTimes(timestampsRef.current.map((ts) => formatRelativeTime(now - ts)));
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // No streaming events — show engagement status instead
  if (events.length === 0) {
    return (
      <div className={cn("h-full overflow-hidden rounded-lg border border-white/[0.08] bg-zinc-900", className)}>
        <IdleState engagementId={engagementId} />
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-lg border border-white/[0.08] bg-zinc-900", className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-1.5">
        <span className="text-[11px] font-medium text-zinc-400">{t("activity.title")}</span>
        <Badge variant="secondary" className="h-4 text-[10px]">
          {events.length}
        </Badge>
      </div>

      {/* Feed */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-transparent">
          {events.map((event, i) => (
            <EventRow
              key={`${event.type}-${event.agent}-${i}`}
              event={event}
              relativeTime={relTimes[i] ?? "now"}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
