import fs from "node:fs";
import path from "node:path";

export interface SessionOwnershipConflict {
  ok: false;
  ownerBotId: string;
}

export interface SessionOwnershipGranted {
  ok: true;
}

export type SessionOwnershipResult = SessionOwnershipConflict | SessionOwnershipGranted;

export interface SessionOwnershipRegistry {
  claim(botId: string, threadId: string): SessionOwnershipResult;
  release(botId: string, threadId: string): void;
  ownerOf(threadId: string): string | null;
}

export class InMemorySessionOwnershipRegistry implements SessionOwnershipRegistry {
  readonly #owners = new Map<string, string>();

  claim(botId: string, threadId: string): SessionOwnershipResult {
    const ownerBotId = this.#owners.get(threadId);
    if (ownerBotId && ownerBotId !== botId) {
      return {
        ok: false,
        ownerBotId,
      };
    }
    this.#owners.set(threadId, botId);
    return { ok: true };
  }

  release(botId: string, threadId: string): void {
    if (this.#owners.get(threadId) === botId) {
      this.#owners.delete(threadId);
    }
  }

  ownerOf(threadId: string): string | null {
    return this.#owners.get(threadId) ?? null;
  }
}

export class PersistentSessionOwnershipRegistry implements SessionOwnershipRegistry {
  readonly #filePath: string;
  readonly #owners = new Map<string, string>();

  constructor(filePath: string) {
    this.#filePath = filePath;
    this.#load();
  }

  claim(botId: string, threadId: string): SessionOwnershipResult {
    const ownerBotId = this.#owners.get(threadId);
    if (ownerBotId && ownerBotId !== botId) {
      return {
        ok: false,
        ownerBotId,
      };
    }
    this.#owners.set(threadId, botId);
    this.#persist();
    return { ok: true };
  }

  release(botId: string, threadId: string): void {
    if (this.#owners.get(threadId) === botId) {
      this.#owners.delete(threadId);
      this.#persist();
    }
  }

  ownerOf(threadId: string): string | null {
    return this.#owners.get(threadId) ?? null;
  }

  replaceAll(entries: Record<string, string>): void {
    this.#owners.clear();
    for (const [threadId, botId] of Object.entries(entries)) {
      this.#owners.set(threadId, botId);
    }
    this.#persist();
  }

  #load(): void {
    try {
      const contents = fs.readFileSync(this.#filePath, "utf8");
      const parsed = JSON.parse(contents) as Record<string, unknown>;
      for (const [threadId, botId] of Object.entries(parsed)) {
        if (typeof botId === "string") {
          this.#owners.set(threadId, botId);
        }
      }
    } catch (error) {
      if (!isFileMissing(error)) {
        throw error;
      }
    }
  }

  #persist(): void {
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    fs.writeFileSync(this.#filePath, `${JSON.stringify(Object.fromEntries(this.#owners), null, 2)}\n`, "utf8");
    if (process.platform !== "win32") {
      fs.chmodSync(this.#filePath, 0o600);
    }
  }
}

function isFileMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
