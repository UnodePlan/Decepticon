"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { FileWarning, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";
import { severityLabel } from "@/lib/i18n";
interface Finding {
  id: string;
  title: string;
  severity: string;
  description: string;
  evidence: string;
  attackVector: string;
  affectedAssets: string[];
  cvssScore?: number;
  cvssVector?: string;
  cwe?: string[];
  mitre?: string[];
  remediation?: string;
}

const severityColors: Record<string, string> = {
  critical: "bg-red-500/10 text-red-400 border-red-500/20",
  high: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  low: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  informational: "bg-slate-500/10 text-slate-400 border-slate-500/20",
};

const severityOrder: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

export default function FindingsPage() {
  const { t, locale } = useI18n();
  const params = useParams();
  const engagementId = params.id as string;
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterSeverity, setFilterSeverity] = useState<string>("all");
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/engagements/${engagementId}/findings`)
      .then((res) => {
        if (!res.ok) throw new Error("fetch failed");
        return res.json();
      })
      .then((data: Finding[]) => {
        if (!active) return;
        const sorted = [...data].sort(
          (a, b) =>
            (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5)
        );
        setFindings(sorted);
      })
      .catch(() => {
        if (!active) return;
        setFindings([]);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [engagementId]);

  const filtered =
    filterSeverity === "all"
      ? findings
      : findings.filter((f) => f.severity === filterSeverity);

  if (selectedFinding) {
    return (
      <div className="space-y-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSelectedFinding(null)}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("findings.back")}
        </Button>

        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {selectedFinding.title}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {selectedFinding.id}
            </Badge>
            <Badge
              variant="outline"
              className={severityColors[selectedFinding.severity] ?? ""}
            >
              {severityLabel(locale, selectedFinding.severity)}
            </Badge>
            {selectedFinding.cvssScore != null && (
              <Badge variant="outline" className="font-mono text-xs">
                CVSS {selectedFinding.cvssScore.toFixed(1)}
              </Badge>
            )}
            {selectedFinding.cwe?.map((c) => (
              <Badge key={c} variant="secondary" className="text-[10px] font-mono">{c}</Badge>
            ))}
            {selectedFinding.mitre?.map((m) => (
              <Badge key={m} variant="secondary" className="text-[10px] font-mono">{m}</Badge>
            ))}
          </div>
        </div>

        {selectedFinding.cvssVector && (
          <div className="rounded-lg border border-border/50 bg-muted/30 px-4 py-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t("findings.detail.cvssVector")}</span>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{selectedFinding.cvssVector}</p>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("findings.detail.description")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {selectedFinding.description}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("findings.detail.attackVector")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {selectedFinding.attackVector}
              </p>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">{t("findings.detail.evidence")}</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 font-mono text-xs text-muted-foreground">
                {selectedFinding.evidence}
              </pre>
            </CardContent>
          </Card>

          {selectedFinding.affectedAssets.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("findings.detail.affectedAssets")}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1">
                  {selectedFinding.affectedAssets.map((asset, i) => (
                    <li
                      key={i}
                      className="text-sm text-muted-foreground"
                    >
                      {asset}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {selectedFinding.remediation && (
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">{t("findings.detail.remediation")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {selectedFinding.remediation}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("findings.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("findings.engagement.subtitle")}
          </p>
        </div>
        <Select value={filterSeverity} onValueChange={(v) => setFilterSeverity(v ?? "all")}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t("severityFilter.placeholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("severityFilter.all")}</SelectItem>
            <SelectItem value="critical">{severityLabel(locale, "critical")}</SelectItem>
            <SelectItem value="high">{severityLabel(locale, "high")}</SelectItem>
            <SelectItem value="medium">{severityLabel(locale, "medium")}</SelectItem>
            <SelectItem value="low">{severityLabel(locale, "low")}</SelectItem>
            <SelectItem value="informational">{severityLabel(locale, "informational")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <div className="text-center">
                <FileWarning className="mx-auto mb-3 h-8 w-8 opacity-50" />
                <p>{t("findings.engagement.empty")}</p>
              </div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.id")}</TableHead>
                  <TableHead>{t("common.title")}</TableHead>
                  <TableHead>{t("severityFilter.severity")}</TableHead>
                  <TableHead>{t("findings.table.cvss")}</TableHead>
                  <TableHead>{t("findings.table.assets")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((finding) => (
                  <TableRow
                    key={finding.id}
                    className="cursor-pointer"
                    onClick={() => setSelectedFinding(finding)}
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {finding.id}
                    </TableCell>
                    <TableCell className="font-medium">
                      {finding.title}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={severityColors[finding.severity] ?? ""}
                      >
                        {severityLabel(locale, finding.severity)}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {finding.cvssScore != null ? finding.cvssScore.toFixed(1) : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {finding.affectedAssets.length > 0
                        ? finding.affectedAssets.join(", ")
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
