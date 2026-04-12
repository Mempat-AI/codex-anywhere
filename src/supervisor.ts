import type { BotRuntimeConfig } from "./types.js";
import type { CodexAnywhereBridge } from "./bridge.js";

export interface BotLaneStatus {
  botId: string;
  label: string;
  workspaceCwd: string;
  status: "ready" | "failed";
  error: string | null;
}

interface BotLane {
  bot: BotRuntimeConfig;
  bridge: CodexAnywhereBridge;
  status: BotLaneStatus["status"];
  error: string | null;
}

export class CodexAnywhereSupervisor {
  readonly #lanes: BotLane[];
  #running = false;

  constructor(lanes: Array<{ bot: BotRuntimeConfig; bridge: CodexAnywhereBridge }>) {
    this.#lanes = lanes.map(({ bot, bridge }) => ({
      bot,
      bridge,
      status: "ready",
      error: null,
    }));
  }

  get primaryBridge(): CodexAnywhereBridge {
    return this.#lanes[0]!.bridge;
  }

  async runLoops(): Promise<void> {
    this.#running = true;
    await Promise.all(
      this.#lanes.map((lane) => this.#runLane(lane)),
    );
  }

  addLane(bot: BotRuntimeConfig, bridge: CodexAnywhereBridge): void {
    const lane: BotLane = {
      bot,
      bridge,
      status: "ready",
      error: null,
    };
    this.#lanes.push(lane);
    if (this.#running) {
      void this.#runLane(lane);
    }
  }

  getStatus(): BotLaneStatus[] {
    return this.#lanes.map((lane) => ({
      botId: lane.bot.id,
      label: lane.bot.label,
      workspaceCwd: lane.bot.workspaceCwd,
      status: lane.status,
      error: lane.error,
    }));
  }

  async #runLane(lane: BotLane): Promise<void> {
    try {
      await lane.bridge.runLoops();
    } catch (error) {
      lane.status = "failed";
      lane.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}
