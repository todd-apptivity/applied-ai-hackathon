/**
 * Token persistence for the Clio connection.
 *
 * The hackathon build is single-tenant: one firm, one Clio account, one set
 * of tokens. They live in a gitignored JSON file so the dev server can
 * restart without re-running the OAuth dance. Swap `FileTokenStore` for a
 * row in Ninety's database when the app becomes multi-tenant — the rest of
 * the Clio layer only talks to the `TokenStore` interface.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getClioConfig } from "./config";
import type { ClioTokens } from "./types";

export interface TokenStore {
  read(): Promise<ClioTokens | null>;
  write(tokens: ClioTokens): Promise<void>;
  clear(): Promise<void>;
}

export class FileTokenStore implements TokenStore {
  private readonly dir: string;
  private readonly path: string;
  private cache: ClioTokens | null | undefined;

  /**
   * `filename` is resolved inside `.clio/`. The directory is a literal here
   * so the bundler scopes filesystem tracing to that folder instead of the
   * whole project.
   */
  constructor(filename: string) {
    this.dir = join(process.cwd(), ".clio");
    this.path = join(this.dir, basename(filename));
  }

  async read(): Promise<ClioTokens | null> {
    if (this.cache !== undefined) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      this.cache = JSON.parse(raw) as ClioTokens;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cache = null;
    }
    return this.cache;
  }

  async write(tokens: ClioTokens): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path, `${JSON.stringify(tokens, null, 2)}\n`, {
      mode: 0o600,
    });
    this.cache = tokens;
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
    this.cache = null;
  }
}

let store: TokenStore | undefined;

export function getTokenStore(): TokenStore {
  store ??= new FileTokenStore(getClioConfig().tokenFile);
  return store;
}

/** Test seam: override the store used by the rest of the Clio layer. */
export function setTokenStore(next: TokenStore): void {
  store = next;
}
