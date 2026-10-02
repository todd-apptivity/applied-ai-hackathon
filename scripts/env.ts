import fs from "node:fs";

/** Loads .env.local then .env for CLI scripts (Next.js does this for the app). */
export function loadEnvFiles(): void {
  for (const file of [".env.local", ".env"]) {
    if (fs.existsSync(file)) process.loadEnvFile(file);
  }
}
