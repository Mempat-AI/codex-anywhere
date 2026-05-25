import fs from "node:fs/promises";
import path from "node:path";

import type { JsonObject } from "./types.js";

export interface UpgradeDiagnosticsPaths {
  logDir: string;
  journalPath: string;
  statePath: string;
}

export interface UpgradeDiagnosticEvent extends JsonObject {
  event: string;
  attemptId: string;
}

export function upgradeDiagnosticsPaths(storageRoot: string): UpgradeDiagnosticsPaths {
  const logDir = path.join(storageRoot, "logs");
  return {
    logDir,
    journalPath: path.join(logDir, "upgrade-events.jsonl"),
    statePath: path.join(logDir, "upgrade-state.json"),
  };
}

export async function appendUpgradeDiagnosticEvent(
  storageRoot: string,
  event: UpgradeDiagnosticEvent,
): Promise<UpgradeDiagnosticsPaths> {
  const paths = upgradeDiagnosticsPaths(storageRoot);
  const entry = {
    ts: new Date().toISOString(),
    ...event,
  };
  await fs.mkdir(paths.logDir, { recursive: true });
  await fs.appendFile(paths.journalPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(paths.journalPath, 0o600).catch(() => {});
  await fs.writeFile(
    paths.statePath,
    `${JSON.stringify({
      updatedAt: entry.ts,
      latest: entry,
      journalPath: paths.journalPath,
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.chmod(paths.statePath, 0o600).catch(() => {});
  return paths;
}
