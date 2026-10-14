"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Crosshair,
  Radio,
  ClipboardList,
  FileWarning,
  Network,
  Settings,
  Clock,
  FolderOpen,
  Download,
  Search,
  Gauge,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n-context";
import type { TranslationKey } from "@/lib/i18n";

interface CommandItem {
  id: string;
  labelKey: TranslationKey;
  shortcut?: string;
  icon: typeof Search;
  action: () => void;
  sectionKey: TranslationKey;
}

export function CommandPalette() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const router = useRouter();
  const pathname = usePathname();

  // Extract engagement ID from current path
  const engMatch = pathname.match(/^\/engagements\/([^/]+)/);
  const engId = engMatch?.[1] ?? null;

  const commands: CommandItem[] = [
    // Global
    { id: "home", labelKey: "palette.goDashboard", shortcut: "G D", icon: LayoutDashboard, action: () => router.push("/"), sectionKey: "palette.section.navigation" },
    { id: "engagements", labelKey: "palette.goEngagements", shortcut: "G E", icon: Crosshair, action: () => router.push("/engagements"), sectionKey: "palette.section.navigation" },
    { id: "settings", labelKey: "palette.goSettingsModels", icon: Settings, action: () => router.push("/settings/models"), sectionKey: "palette.section.navigation" },
    { id: "settings-runtime", labelKey: "palette.goSettingsRuntime", icon: Gauge, action: () => router.push("/settings/runtime"), sectionKey: "palette.section.navigation" },
    { id: "settings-status", labelKey: "palette.goSettingsStatus", icon: Activity, action: () => router.push("/settings/status"), sectionKey: "palette.section.navigation" },
    { id: "graph", labelKey: "palette.goAttackGraph", icon: Network, action: () => router.push("/graph"), sectionKey: "palette.section.navigation" },
    // Engagement-scoped (only when in an engagement)
    ...(engId ? [
      { id: "live", labelKey: "palette.goLive", shortcut: "G L", icon: Radio, action: () => router.push(`/engagements/${engId}/live`), sectionKey: "palette.section.engagement" },
      { id: "plan", labelKey: "palette.goPlan", shortcut: "G P", icon: ClipboardList, action: () => router.push(`/engagements/${engId}/plan`), sectionKey: "palette.section.engagement" },
      { id: "timeline", labelKey: "palette.goTimeline", icon: Clock, action: () => router.push(`/engagements/${engId}/timeline`), sectionKey: "palette.section.engagement" },
      { id: "docs", labelKey: "palette.goDocuments", icon: FolderOpen, action: () => router.push(`/engagements/${engId}/documents`), sectionKey: "palette.section.engagement" },
      { id: "findings", labelKey: "palette.goFindings", shortcut: "G F", icon: FileWarning, action: () => router.push(`/engagements/${engId}/findings`), sectionKey: "palette.section.engagement" },
      { id: "eng-graph", labelKey: "palette.goEngagementGraph", icon: Network, action: () => router.push(`/engagements/${engId}/graph`), sectionKey: "palette.section.engagement" },
      { id: "export-json", labelKey: "palette.exportJson", icon: Download, action: () => window.open(`/api/engagements/${engId}/export?format=json`), sectionKey: "palette.section.actions" },
      { id: "export-md", labelKey: "palette.exportMarkdown", icon: Download, action: () => window.open(`/api/engagements/${engId}/export?format=markdown`), sectionKey: "palette.section.actions" },
    ] as CommandItem[] : []),
  ];

  const filtered = query
    ? commands.filter((c) => t(c.labelKey).toLowerCase().includes(query.toLowerCase()))
    : commands;

  // Reset selection when filter changes
  useEffect(() => setSelectedIndex(0), [query]);

  const execute = useCallback((cmd: CommandItem) => {
    setOpen(false);
    setQuery("");
    cmd.action();
  }, []);

  // Keyboard handler
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+K or Cmd+K to toggle
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }

      if (!open) return;

      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (filtered.length > 0) setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (filtered.length > 0) setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && filtered[selectedIndex]) {
        e.preventDefault();
        execute(filtered[selectedIndex]);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, filtered, selectedIndex, execute]);

  if (!open) return null;

  // Group by section
  const sections: Record<string, CommandItem[]> = {};
  for (const cmd of filtered) {
    const title = t(cmd.sectionKey);
    sections[title] = [...(sections[title] ?? []), cmd];
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={() => { setOpen(false); setQuery(""); }} />

      {/* Palette */}
      <div className="fixed left-1/2 top-[20%] z-50 w-[520px] -translate-x-1/2 overflow-hidden rounded-xl border border-white/[0.1] bg-zinc-900 shadow-2xl">
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-white/[0.08] px-4 py-3">
          <Search className="h-4 w-4 text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("palette.placeholder")}
            className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-zinc-500"
            autoFocus
          />
          <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">ESC</kbd>
        </div>

        {/* Results */}
        <div className="max-h-[340px] overflow-auto p-2">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">{t("palette.noResults")}</p>
          ) : (
            Object.entries(sections).map(([section, items]) => (
              <div key={section} className="mb-1">
                <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                  {section}
                </p>
                {items.map((cmd) => {
                  const globalIdx = filtered.indexOf(cmd);
                  const isSelected = globalIdx === selectedIndex;
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      onClick={() => execute(cmd)}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                        isSelected ? "bg-white/[0.08] text-white" : "text-zinc-400 hover:bg-white/[0.04]",
                      )}
                    >
                      <cmd.icon className="h-4 w-4 shrink-0 text-zinc-500" />
                      <span className="flex-1">{t(cmd.labelKey)}</span>
                      {cmd.shortcut && (
                        <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-600">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-white/[0.06] px-4 py-2 text-[10px] text-zinc-600">
          <span className="mr-3">{t("palette.navigate")}</span>
          <span className="mr-3">{t("palette.select")}</span>
          <span>{t("palette.close")}</span>
        </div>
      </div>
    </>
  );
}
