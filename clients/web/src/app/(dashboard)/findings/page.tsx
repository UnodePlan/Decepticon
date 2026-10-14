"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FileWarning } from "lucide-react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/i18n";
interface Engagement {
  id: string;
  name: string;
  status: string;
}

export default function FindingsPage() {
  const { t, locale } = useI18n();
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/engagements")
      .then((res) => {
        if (!res.ok) throw new Error("fetch failed");
        return res.json();
      })
      .then((data: Engagement[]) => {
        if (!active) return;
        setEngagements(data.filter((e) => e.status === "completed"));
      })
      .catch(() => {
        if (!active) return;
        setEngagements([]);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("findings.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("findings.subtitle")}
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : engagements.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <div className="text-center text-sm text-muted-foreground">
              <FileWarning className="mx-auto mb-3 h-8 w-8 opacity-50" />
              <p>{t("findings.empty.title")}</p>
              <p className="mt-1 text-xs">
                {t("findings.empty.description")}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {engagements.map((eng) => (
            <Link key={eng.id} href={`/engagements/${eng.id}/findings`}>
              <Card className="transition-colors hover:border-primary/50">
                <CardHeader>
                  <CardTitle className="text-base">{eng.name}</CardTitle>
                  <CardDescription>
                    <Badge
                      variant="outline"
                      className="bg-green-500/10 text-green-400 border-green-500/20"
                    >
                      {statusLabel(locale, eng.status)}
                    </Badge>
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">
                    {t("findings.view")}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
