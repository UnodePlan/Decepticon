// Prisma CLI configuration for the web dashboard.
//
// Why this file loads the env files itself: Prisma 7 loads its config through
// `c12` with `dotenv: false` (see `@prisma/config`), so the CLI never
// populates `process.env` from `.env` files. The generated `import
// "dotenv/config"` that used to live here only read `.env` (never
// `.env.local`) from whatever directory the command ran in, which left
// `DATABASE_URL` undefined for the documented local workflow
// (`cd clients/web && npx prisma migrate dev`) — the local connection string
// lives in `clients/web/.env.local`.
//
// Resolution order for every variable (Docker/CI injected values always win):
//   1. the ambient process environment (compose `environment:`, `docker run -e`,
//      CI secrets, `DATABASE_URL=… npx prisma …`)
//   2. `clients/web/.env.local` (private, gitignored local overrides)
//   3. `clients/web/.env` (committed defaults)
//
// Neither file can shadow the process environment — dotenv never overwrites an
// already-set variable. Loading `.env.local` before `.env` makes the private
// file win over the committed default. Missing files are ignored;
// `quiet: true` keeps dotenv's "injected env (n) from <path>" banner, which
// echoes a file path, out of CLI output.
//
// `DATABASE_URL` is the only variable this config consumes; the other keys in
// the env files are read by Next.js or the deployment tooling, not by Prisma.
// If nothing supplies it, `datasource.url` stays undefined and the CLI reports
// exactly which property is required — it never echoes a connection string.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// jiti (Prisma's config loader) runs this file in a CommonJS wrapper and sets
// `__dirname` to the config file's directory, which is also the base Prisma
// resolves `schema`/`migrations` against. The `import.meta` branch covers a
// future native-ESM loader.
const CONFIG_DIR =
  typeof __dirname === "string"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

/** First match wins: private local overrides, then the committed defaults. */
const ENV_FILES = [".env.local", ".env"] as const;

function loadEnvFiles(): void {
  if (process.env["DATABASE_URL"] !== undefined) {
    return; // injected environment already covers the datasource — leave env files untouched
  }
  for (const file of ENV_FILES) {
    const { error } = loadEnv({
      path: path.join(CONFIG_DIR, file),
      quiet: true,
    });
    if (error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Unreadable or malformed file — failing loudly beats a silent fallback
      // that would later surface as a confusing "url is required" error.
      throw error;
    }
  }
}

loadEnvFiles();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Read after env loading so the datasource sees the resolved value.
    url: process.env["DATABASE_URL"],
  },
});
