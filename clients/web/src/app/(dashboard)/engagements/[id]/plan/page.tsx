"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Target, FileText, Shield, Radio,
  Loader2, CheckCircle2, XCircle, Clock, AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { RenderStructuredDocument } from "@/components/plan/structured-document";
import { useI18n } from "@/lib/i18n-context";
import type { TranslationKey } from "@/lib/i18n";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Document metadata ──────────────────────────────────────────────

const DOC_META: { key: string; labelKey: TranslationKey; descKey: TranslationKey; icon: typeof Target; color: string }[] = [
  { key: "opplan", labelKey: "plan.doc.opplan", descKey: "plan.doc.opplan.desc", icon: Target, color: "text-amber-400" },
  { key: "roe", labelKey: "plan.doc.roe", descKey: "plan.doc.roe.desc", icon: Shield, color: "text-emerald-400" },
  { key: "threat-profile", labelKey: "plan.doc.threatProfile", descKey: "plan.doc.threatProfile.desc", icon: Target, color: "text-red-400" },
  { key: "conops", labelKey: "plan.doc.conops", descKey: "plan.doc.conops.desc", icon: FileText, color: "text-cyan-400" },
  { key: "deconfliction", labelKey: "plan.doc.deconfliction", descKey: "plan.doc.deconfliction.desc", icon: Radio, color: "text-purple-400" },
  { key: "contact", labelKey: "plan.doc.contact", descKey: "plan.doc.contact.desc", icon: FileText, color: "text-blue-400" },
  { key: "data-handling", labelKey: "plan.doc.dataHandling", descKey: "plan.doc.dataHandling.desc", icon: Shield, color: "text-teal-400" },
  { key: "abort", labelKey: "plan.doc.abort", descKey: "plan.doc.abort.desc", icon: AlertTriangle, color: "text-orange-400" },
  { key: "cleanup", labelKey: "plan.doc.cleanup", descKey: "plan.doc.cleanup.desc", icon: CheckCircle2, color: "text-lime-400" },
];

// ── Status helpers ─────────────────────────────────────────────────

const statusIcon: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  completed: { icon: CheckCircle2, color: "text-green-400" },
  blocked: { icon: XCircle, color: "text-red-400" },
  "in-progress": { icon: Loader2, color: "text-amber-400" },
  pending: { icon: Clock, color: "text-muted-foreground" },
  cancelled: { icon: XCircle, color: "text-muted-foreground/50" },
};

const severityColor: Record<string, string> = {
  loud: "text-red-400",
  standard: "text-amber-400",
  careful: "text-yellow-400",
  quiet: "text-blue-400",
  silent: "text-emerald-400",
};

// ── Section component ──────────────────────────────────────────────

/** Safely render a value that might be an object instead of a string. */
function SafeText({ value, className }: { value: unknown; className?: string }) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return <p className={className}>{value}</p>;
  if (typeof value === "boolean" || typeof value === "number") return <p className={className}>{String(value)}</p>;
  return (
    <pre className="whitespace-pre-wrap text-xs text-foreground/80 rounded bg-muted/50 p-2 font-mono">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || value === "") return null;
  const display = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  const isBlock = display.includes("\n");
  return (
    <div className={isBlock ? "space-y-1 text-sm" : "flex gap-3 text-sm"}>
      <span className="w-40 shrink-0 text-muted-foreground">{label}</span>
      {isBlock ? (
        <pre className="whitespace-pre-wrap text-xs text-foreground/80 rounded bg-muted/50 p-2 font-mono">{display}</pre>
      ) : (
        <span className="text-foreground">{display}</span>
      )}
    </div>
  );
}

// ── OPPLAN renderer ────────────────────────────────────────────────

function RenderOpplan({ data }: { data: any }) {
  const { t } = useI18n();
  const objectives: any[] = data.objectives ?? [];
  const completed = objectives.filter((o: any) => o.status === "completed").length;
  const blocked = objectives.filter((o: any) => o.status === "blocked").length;
  const total = objectives.length;
  const progress = total > 0 ? ((completed + blocked) / total) * 100 : 0;

  return (
    <div className="space-y-6">
      <Section title={t("plan.section.engagement")}>
        <Field label={t("common.name")} value={data.engagement_name} />
        <Field label={t("plan.field.threatProfile")} value={data.threat_profile} />
      </Section>

      <Separator className="opacity-30" />

      <Section title={t("plan.section.progress")}>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {t("plan.progress.objectives", { resolved: completed + blocked, total })}
            </span>
            <span className="font-medium">{Math.round(progress)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span className="text-green-400">{t("plan.progress.passed", { count: completed })}</span>
            <span className="text-red-400">{t("plan.progress.blocked", { count: blocked })}</span>
            <span>{t("plan.progress.remaining", { count: total - completed - blocked })}</span>
          </div>
        </div>
      </Section>

      {objectives.length > 0 && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.objectives")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">{t("common.id")}</TableHead>
                  <TableHead>{t("common.title")}</TableHead>
                  <TableHead className="w-28">{t("common.phase")}</TableHead>
                  <TableHead className="w-24">{t("plan.field.opsec")}</TableHead>
                  <TableHead className="w-24">{t("common.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {objectives
                  .sort((a: any, b: any) => (a.priority ?? 0) - (b.priority ?? 0))
                  .map((obj: any) => {
                    const st = statusIcon[obj.status] ?? statusIcon.pending;
                    const StIcon = st.icon;
                    return (
                      <TableRow key={obj.id}>
                        <TableCell className="font-mono text-xs">{obj.id}</TableCell>
                        <TableCell>
                          <div className="text-sm font-medium">{obj.title}</div>
                          {obj.description && (
                            <div className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                              {obj.description}
                            </div>
                          )}
                          {obj.mitre?.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {obj.mitre.map((t: string) => (
                                <Badge key={t} variant="outline" className="text-[10px] px-1 py-0">
                                  {t}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">{obj.phase}</Badge>
                        </TableCell>
                        <TableCell>
                          <span className={cn("text-xs", severityColor[obj.opsec])}>
                            {obj.opsec ?? "standard"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <StIcon className={cn("h-3.5 w-3.5", st.color, obj.status === "in-progress" && "animate-spin")} />
                            <span className={cn("text-xs", st.color)}>{obj.status}</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </Section>
        </>
      )}
    </div>
  );
}

// ── CONOPS renderer ────────────────────────────────────────────────

function RenderConops({ data }: { data: any }) {
  const { t } = useI18n();
  const actors: any[] = data.threat_actors ?? [];
  const killchain: any[] = data.kill_chain ?? [];
  const criteria: string[] = data.success_criteria ?? [];
  const timeline: Record<string, string> = data.phases_timeline ?? {};

  return (
    <div className="space-y-6">
      <Section title={t("plan.section.engagement")}>
        <Field label={t("common.name")} value={data.engagement_name} />
        <Field label={t("plan.field.methodology")} value={data.methodology} />
      </Section>

      {data.executive_summary && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.executiveSummary")}>
            <SafeText value={data.executive_summary} className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap" />
          </Section>
        </>
      )}

      {actors.length > 0 && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.threatActors")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("plan.field.actor")}</TableHead>
                  <TableHead>{t("plan.field.sophistication")}</TableHead>
                  <TableHead>{t("plan.field.motivation")}</TableHead>
                  <TableHead>{t("plan.field.keyTtps")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {actors.map((a: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium text-sm">{a.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{a.sophistication}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{a.motivation}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(a.ttps ?? []).slice(0, 5).map((t: string) => (
                          <Badge key={t} variant="outline" className="text-[10px] px-1 py-0">{t}</Badge>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      )}

      {data.attack_narrative && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.attackNarrative")}>
            <SafeText value={data.attack_narrative} className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap" />
          </Section>
        </>
      )}

      {killchain.length > 0 && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.killChain")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">{t("common.phase")}</TableHead>
                  <TableHead>{t("common.description")}</TableHead>
                  <TableHead className="w-40">{t("common.tools")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {killchain.map((k: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{k.phase}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{k.description}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {(k.tools ?? []).join(", ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      )}

      {Object.keys(timeline).length > 0 && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.timeline")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.phase")}</TableHead>
                  <TableHead>{t("common.duration")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(timeline).map(([phase, range]) => (
                  <TableRow key={phase}>
                    <TableCell className="font-medium text-sm">{phase}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{range}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      )}

      {criteria.length > 0 && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.successCriteria")}>
            <ul className="space-y-1.5">
              {criteria.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}

      {data.communication_plan && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.communicationPlan")}>
            {typeof data.communication_plan === "string" ? (
              <p className="text-sm text-foreground/90 whitespace-pre-wrap">{data.communication_plan}</p>
            ) : (
              <div className="space-y-2">
                {Object.entries(data.communication_plan).map(([k, v]) => (
                  <Field key={k} label={k.replace(/_/g, " ")} value={v} />
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

// ── ROE renderer ───────────────────────────────────────────────────

function RenderRoe({ data }: { data: any }) {
  const { t } = useI18n();
  const inScope: any[] = data.in_scope ?? [];
  const outScope: any[] = data.out_of_scope ?? [];
  const prohibited: string[] = data.prohibited_actions ?? [];
  const permitted: string[] = data.permitted_actions ?? [];
  const contacts: any[] = data.escalation_contacts ?? [];

  return (
    <div className="space-y-6">
      <Section title={t("plan.section.engagementDetails")}>
        <Field label={t("common.name")} value={data.engagement_name} />
        <Field label={t("plan.field.client")} value={data.client} />
        <Field label={t("common.type")} value={data.engagement_type} />
        <Field label={t("plan.field.startDate")} value={data.start_date} />
        <Field label={t("plan.field.endDate")} value={data.end_date} />
        <Field label={t("plan.field.testingWindow")} value={data.testing_window} />
        <Field label={t("plan.field.authorization")} value={data.authorization_reference} />
        <Field label={t("plan.field.version")} value={data.version} />
      </Section>

      {inScope.length > 0 && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.inScope")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("plan.field.target")}</TableHead>
                  <TableHead>{t("common.type")}</TableHead>
                  <TableHead>{t("common.notes")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inScope.map((s: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-sm">{s.target}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{s.type}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.notes || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      )}

      {outScope.length > 0 && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.outOfScope")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("plan.field.target")}</TableHead>
                  <TableHead>{t("common.type")}</TableHead>
                  <TableHead>{t("common.notes")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outScope.map((s: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-sm">{s.target}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{s.type}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.notes || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      )}

      {prohibited.length > 0 && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.prohibitedActions")}>
            <ul className="space-y-1.5">
              {prohibited.map((p, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}

      {permitted.length > 0 && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.permittedActions")}>
            <ul className="space-y-1.5">
              {permitted.map((p, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}

      {contacts.length > 0 && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.escalationContacts")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.name")}</TableHead>
                  <TableHead>{t("common.role")}</TableHead>
                  <TableHead>{t("common.channel")}</TableHead>
                  <TableHead>{t("common.available")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.map((c: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium text-sm">{c.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{c.role}</TableCell>
                    <TableCell className="font-mono text-xs">{c.channel}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{c.available ?? "24/7"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      )}

      {data.incident_procedure && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.incidentProcedure")}>
            <SafeText value={data.incident_procedure} className="text-sm text-foreground/90 whitespace-pre-wrap" />
          </Section>
        </>
      )}

      {data.data_handling && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.dataHandling")}>
            <SafeText value={data.data_handling} className="text-sm text-foreground/90 whitespace-pre-wrap" />
          </Section>
        </>
      )}

      <Separator className="opacity-30" />
      <Section title={t("plan.section.cleanup")}>
        <Field label={t("plan.field.cleanupRequired")} value={t(data.cleanup_required ? "common.yes" : "common.no")} />
      </Section>
    </div>
  );
}

// ── Deconfliction renderer ─────────────────────────────────────────

function RenderDeconfliction({ data }: { data: any }) {
  const { t } = useI18n();
  const identifiers: any[] = data.identifiers ?? [];

  return (
    <div className="space-y-6">
      <Section title={t("plan.section.engagement")}>
        <Field label={t("common.name")} value={data.engagement_name} />
        <Field label={t("plan.field.socContact")} value={data.soc_contact} />
        <Field label={t("plan.field.deconflictionCode")} value={data.deconfliction_code} />
      </Section>

      {identifiers.length > 0 && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.redTeamIdentifiers")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.type")}</TableHead>
                  <TableHead>{t("common.value")}</TableHead>
                  <TableHead>{t("common.description")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {identifiers.map((id: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{id.type}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{id.value}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{id.description || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      )}

      {data.notification_procedure && (
        <>
          <Separator className="opacity-30" />
          <Section title={t("plan.section.notificationProcedure")}>
            <SafeText value={data.notification_procedure} className="text-sm text-foreground/90 whitespace-pre-wrap" />
          </Section>
        </>
      )}
    </div>
  );
}

// ── Renderer dispatch ──────────────────────────────────────────────

const renderers: Record<string, React.FC<{ data: any }>> = {
  opplan: RenderOpplan,
  conops: RenderConops,
  roe: RenderRoe,
  deconfliction: RenderDeconfliction,
  "threat-profile": RenderStructuredDocument,
  contact: RenderStructuredDocument,
  "data-handling": RenderStructuredDocument,
  abort: RenderStructuredDocument,
  cleanup: RenderStructuredDocument,
};

// ── Page ───────────────────────────────────────────────────────────

export default function PlanPage() {
  const { t } = useI18n();
  const params = useParams();
  const id = params.id as string;
  const [docs, setDocs] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/engagements/${id}/plan-docs`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: Record<string, any>) => {
        if (!active) return;
        setDocs(data);
        const first = DOC_META.find((d) => data[d.key]);
        if (first) setSelected(first.key);
      })
      .catch((err) => {
        if (active) console.error("Failed to load plan docs", err);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasAnyDoc = DOC_META.some((d) => docs[d.key]);

  if (!hasAnyDoc) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("plan.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("plan.subtitle")}</p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Target className="mb-3 h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm font-medium">{t("plan.empty.title")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("plan.empty.description")}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const selectedData = selected ? docs[selected] : null;
  const Renderer = selected ? renderers[selected] : null;
  const selectedMeta = DOC_META.find((d) => d.key === selected);

  return (
    <div className="flex h-full gap-4 overflow-hidden">
      {/* Left: Document list */}
      <div className="w-64 shrink-0 space-y-1.5">
        <div className="mb-3">
          <h1 className="text-lg font-bold tracking-tight">{t("plan.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("plan.documents")}</p>
        </div>

        {DOC_META.map((doc) => {
          const exists = !!docs[doc.key];
          const active = selected === doc.key;
          return (
            <button
              key={doc.key}
              onClick={() => exists && setSelected(doc.key)}
              disabled={!exists}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                active
                  ? "bg-primary/10 border border-primary/20"
                  : exists
                    ? "hover:bg-accent"
                    : "opacity-30 cursor-not-allowed"
              )}
            >
              <doc.icon className={cn("h-4 w-4 shrink-0", active ? doc.color : "text-muted-foreground")} />
              <div className="min-w-0 flex-1">
                <div className={cn("text-sm font-medium", active ? "text-foreground" : "text-muted-foreground")}>
                  {t(doc.labelKey)}
                </div>
                <div className="text-[10px] text-muted-foreground/70 truncate">{t(doc.descKey)}</div>
              </div>
              {exists ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500/70" />
              ) : (
                <AlertTriangle className="h-3 w-3 shrink-0 text-muted-foreground/30" />
              )}
            </button>
          );
        })}
      </div>

      {/* Right: Document content */}
      <Card className="flex-1 overflow-hidden">
        <CardHeader className="border-b border-border/50 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {selectedMeta && (
              <selectedMeta.icon className={cn("h-4 w-4", selectedMeta.color)} />
            )}
            {selectedMeta ? t(selectedMeta.labelKey) : t("plan.selectDocument")}
            <span className="text-xs font-normal text-muted-foreground">
              {selectedMeta ? t(selectedMeta.descKey) : null}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[calc(100vh-14rem)]">
            <div className="p-6">
              {selectedData && Renderer ? (
                <Renderer data={selectedData} />
              ) : (
                <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                  {t("plan.selectDocumentHint")}
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
