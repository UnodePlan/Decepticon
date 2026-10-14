/**
 * Prisma-backed {@link SettingsStore} — the only module in the settings stack
 * that touches the database.
 *
 * Rows live in the `SystemSetting` key/value table (see prisma/schema.prisma);
 * the pure merge/validate policy is in `./system-settings`, and the store-agnostic
 * snapshot assembly is in `./system-settings-runtime`.
 */

import { prisma } from "./prisma";
import { loadSettings, type LoadedSettings, type SettingsStore } from "./system-settings-runtime";
import { type SettingsEnv, type SettingsSnapshot } from "./system-settings";

export const prismaSettingsStore: SettingsStore = {
  async read() {
    // A missing table (migration not applied) rejects; the route maps that to a
    // 500 instead of silently pretending every setting is at its default.
    return prisma.systemSetting.findMany({ select: { key: true, value: true } });
  },

  async write(changes) {
    if (changes.length === 0) return;
    await prisma.$transaction(
      changes.map(({ key, value }) =>
        value === null
          ? // `deleteMany`: clearing an already-absent key is a no-op, not an error.
            prisma.systemSetting.deleteMany({ where: { key } })
          : prisma.systemSetting.upsert({
              where: { key },
              create: { key, value },
              update: { value },
            }),
      ),
    );
  },
};

/** Convenience: current settings snapshot from the database. */
export async function readSettingsSnapshot(env: SettingsEnv = process.env): Promise<SettingsSnapshot> {
  return (await loadSettings(prismaSettingsStore, env)).snapshot;
}

/** Convenience: snapshot plus the credential server-side callers must present. */
export function readSettings(env: SettingsEnv = process.env): Promise<LoadedSettings> {
  return loadSettings(prismaSettingsStore, env);
}
