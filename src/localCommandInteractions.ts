import type {
  BotRuntimeConfig,
  ChatSessionState,
  JsonObject,
  PendingInteractiveSessionStep,
} from "./types.js";

export type LocalInteractiveCommand =
  | "addbot"
  | "model"
  | "fast"
  | "permissions"
  | "experimental"
  | "personality"
  | "collab"
  | "plan"
  | "feedback"
  | "agent"
  | "mention"
  | "verbose"
  | "rename"
  | "review";

export interface LocalInteractiveSessionSpec {
  title: string;
  steps: PendingInteractiveSessionStep[];
  meta: JsonObject;
}

export function buildAddBotInteractiveSession(
  config: BotRuntimeConfig,
): LocalInteractiveSessionSpec {
  return {
    title: "Add a Telegram bot.",
    steps: [
      {
        key: "botId",
        prompt: "Reply with a unique bot id (for example: bot-2).",
        kind: "text",
        required: true,
      },
      {
        key: "label",
        prompt: "Reply with a human label, or send - to reuse the bot id.",
        kind: "text",
        required: true,
      },
      {
        key: "telegramBotToken",
        prompt: "Reply with the new Telegram bot token from BotFather.",
        kind: "text",
        required: true,
      },
      {
        key: "workspaceCwd",
        prompt: `Reply with the workspace path for this bot [${config.workspaceCwd}].`,
        kind: "text",
        required: true,
      },
    ],
    meta: { command: "addbot" },
  };
}

export function buildModelInteractiveSession(
  models: unknown[],
  state: ChatSessionState,
): LocalInteractiveSessionSpec | null {
  const options = models
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const model = asString((entry as JsonObject).model);
      if (!model) {
        return null;
      }
      const isDefault = (entry as JsonObject).isDefault === true ? " (default)" : "";
      const current = state.model === model ? " (current)" : "";
      return { label: `${model}${isDefault}${current}`, value: model };
    })
    .filter((entry): entry is { label: string; value: string } => Boolean(entry))
    .slice(0, 20);

  if (options.length === 0) {
    return null;
  }

  options.unshift({ label: "Reset to default", value: "__reset__" });

  return {
    title: "Choose the active model.",
    steps: [
      {
        key: "model",
        prompt: `Current model: ${state.model ?? "default"}${state.reasoningEffort ? ` (${state.reasoningEffort})` : ""}`,
        kind: "choice",
        options,
        required: true,
      },
    ],
    meta: { command: "model", followUpAdded: false },
  };
}

export function buildFastInteractiveSession(state: ChatSessionState): LocalInteractiveSessionSpec {
  return {
    title: "Choose Fast mode.",
    steps: [
      {
        key: "serviceTier",
        prompt: `Fast mode is currently ${state.serviceTier === "fast" ? "on" : "off"}.`,
        kind: "choice",
        options: [
          { label: "On", value: "fast" },
          { label: "Off", value: "default" },
        ],
        required: true,
      },
    ],
    meta: { command: "fast" },
  };
}

export function buildVerboseInteractiveSession(state: ChatSessionState): LocalInteractiveSessionSpec {
  return {
    title: "Choose verbose mode.",
    steps: [
      {
        key: "verboseMode",
        prompt: `Detailed tool/file messages are currently ${state.verbose ? "on" : "off"}.`,
        kind: "choice",
        options: [
          { label: "On", value: "on" },
          { label: "Off", value: "off" },
        ],
        required: true,
      },
    ],
    meta: { command: "verbose" },
  };
}

export function buildApprovalPolicyInteractiveSession(
  state: ChatSessionState,
): LocalInteractiveSessionSpec {
  return {
    title: "Choose the approval policy.",
    steps: [
      {
        key: "approvalPolicy",
        prompt: `Current approval policy: ${state.approvalPolicy ?? "on-request"}`,
        kind: "choice",
        options: [
          { label: "Untrusted", value: "untrusted" },
          { label: "On failure", value: "on-failure" },
          { label: "On request", value: "on-request" },
          { label: "Never", value: "never" },
        ],
        required: true,
      },
    ],
    meta: { command: "permissions" },
  };
}

export function buildExperimentalInteractiveSession(
  features: unknown[],
): LocalInteractiveSessionSpec | null {
  const options = features
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const name = asString((entry as JsonObject).name);
      if (!name) {
        return null;
      }
      const enabled = (entry as JsonObject).enabled === true ? "on" : "off";
      const stage = asString((entry as JsonObject).stage) ?? "unknown";
      return { label: `${name} (${enabled}, ${stage})`, value: name };
    })
    .filter((entry): entry is { label: string; value: string } => Boolean(entry))
    .slice(0, 20);

  if (options.length === 0) {
    return null;
  }

  return {
    title: "Choose an experimental feature.",
    steps: [
      {
        key: "featureName",
        prompt: "Select the feature you want to change.",
        kind: "choice",
        options,
        required: true,
      },
    ],
    meta: { command: "experimental", followUpAdded: false },
  };
}

export function buildPersonalityInteractiveSession(
  state: ChatSessionState,
): LocalInteractiveSessionSpec {
  return {
    title: "Choose Codex personality.",
    steps: [
      {
        key: "personality",
        prompt: `Current personality: ${state.personality ?? "default"}`,
        kind: "choice",
        options: [
          { label: "Default", value: "__default__" },
          { label: "Friendly", value: "friendly" },
          { label: "Pragmatic", value: "pragmatic" },
          { label: "None", value: "none" },
        ],
        required: true,
      },
    ],
    meta: { command: "personality" },
  };
}

export function buildCollaborationInteractiveSession(
  modes: unknown[],
  state: ChatSessionState,
): LocalInteractiveSessionSpec | null {
  const options = collaborationModeOptions(modes, state.collaborationModeName);
  if (options.length === 0) {
    return null;
  }

  options.unshift({ label: "Default (off)", value: "__reset__" });

  return {
    title: "Choose collaboration mode.",
    steps: [
      {
        key: "collaborationModeName",
        prompt: `Current collaboration mode: ${state.collaborationModeName ?? "default"}`,
        kind: "choice",
        options,
        required: true,
      },
    ],
    meta: { command: "collab" },
  };
}

export function buildPlanInteractiveSession(
  modes: unknown[],
  state: ChatSessionState,
): LocalInteractiveSessionSpec | null {
  const options = collaborationModeOptions(modes, state.collaborationModeName).filter(
    (entry) => entry.value.toLowerCase().includes("plan"),
  );
  if (options.length === 0) {
    return null;
  }

  return {
    title: "Choose Plan mode.",
    steps: [
      {
        key: "collaborationModeName",
        prompt: `Current collaboration mode: ${state.collaborationModeName ?? "default"}`,
        kind: "choice",
        options,
        required: true,
      },
    ],
    meta: { command: "plan" },
  };
}

export function buildFeedbackInteractiveSession(): LocalInteractiveSessionSpec {
  return {
    title: "Send feedback.",
    steps: [
      {
        key: "classification",
        prompt: "Choose a feedback category.",
        kind: "choice",
        options: [
          { label: "Bad result", value: "bad_result" },
          { label: "Good result", value: "good_result" },
          { label: "Bug", value: "bug" },
          { label: "Safety check", value: "safety_check" },
          { label: "Other", value: "other" },
        ],
        required: true,
      },
      {
        key: "includeLogs",
        prompt: "Include logs with the feedback?",
        kind: "boolean",
        required: true,
      },
    ],
    meta: { command: "feedback" },
  };
}

export function buildAgentThreadInteractiveSession(
  threads: unknown[],
  currentThreadId: string | null,
): LocalInteractiveSessionSpec | null {
  const options = threads
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const thread = entry as JsonObject;
      const id = asString(thread.id);
      if (!id) {
        return null;
      }
      return {
        label: formatThreadOptionLabel(thread, currentThreadId),
        value: id,
      };
    })
    .filter((entry): entry is { label: string; value: string } => Boolean(entry))
    .slice(0, 20);

  if (options.length === 0) {
    return null;
  }

  return {
    title: "Choose the active agent thread.",
    steps: [
      {
        key: "threadId",
        prompt: "Select a thread to make active.",
        kind: "choice",
        options,
        required: true,
      },
    ],
    meta: { command: "agent" },
  };
}

export function buildMentionInteractiveSession(
  files: string[],
): LocalInteractiveSessionSpec | null {
  const options = files
    .slice(0, 12)
    .map((file) => ({ label: file, value: file }));
  if (options.length === 0) {
    return null;
  }
  return {
    title: "Choose a file to mention.",
    steps: [
      {
        key: "mentionPath",
        prompt: "Select a file to attach to your next message.",
        kind: "choice",
        options,
        required: true,
      },
    ],
    meta: { command: "mention" },
  };
}

export function buildRenameInteractiveSession(): LocalInteractiveSessionSpec {
  return {
    title: "Rename the current thread.",
    steps: [
      {
        key: "threadName",
        prompt: "Reply with the new thread name.",
        kind: "text",
        required: true,
      },
    ],
    meta: { command: "rename" },
  };
}

export function buildReviewInteractiveSession(): LocalInteractiveSessionSpec {
  return {
    title: "Start a review.",
    steps: [
      {
        key: "targetKind",
        prompt: "Choose what to review.",
        kind: "choice",
        options: [
          { label: "Uncommitted changes", value: "uncommittedChanges" },
          { label: "Base branch", value: "baseBranch" },
          { label: "Commit", value: "commit" },
          { label: "Custom instructions", value: "custom" },
        ],
        required: true,
      },
    ],
    meta: { command: "review", followUpAdded: false },
  };
}

export function buildLocalInteractiveFollowUpSteps(
  command: LocalInteractiveCommand,
  answers: Record<string, unknown>,
): PendingInteractiveSessionStep[] {
  switch (command) {
    case "model": {
      const selectedModel = asString(answers.model);
      if (!selectedModel || selectedModel === "__reset__") {
        return [];
      }
      return [
        {
          key: "reasoningEffort",
          prompt: "Choose the reasoning effort.",
          kind: "choice",
          options: [
            { label: "Default", value: "__default__" },
            { label: "Minimal", value: "minimal" },
            { label: "Low", value: "low" },
            { label: "Medium", value: "medium" },
            { label: "High", value: "high" },
          ],
          required: true,
        },
      ];
    }
    case "experimental":
      if (!asString(answers.featureName)) {
        return [];
      }
      return [
        {
          key: "enabled",
          prompt: "Set the feature state.",
          kind: "choice",
          options: [
            { label: "On", value: "on" },
            { label: "Off", value: "off" },
          ],
          required: true,
        },
      ];
    case "personality":
    case "collab":
    case "plan":
    case "feedback":
    case "agent":
    case "mention":
    case "verbose":
      return [];
    case "review": {
      const targetKind = asString(answers.targetKind);
      if (!targetKind || targetKind === "uncommittedChanges") {
        return [];
      }
      return [
        {
          key: "targetValue",
          prompt: reviewValuePrompt(targetKind),
          kind: "text",
          required: true,
        },
      ];
    }
    default:
      return [];
  }
}

function reviewValuePrompt(targetKind: string): string {
  switch (targetKind) {
    case "baseBranch":
      return "Reply with the base branch name to diff against.";
    case "commit":
      return "Reply with the commit SHA to review.";
    case "custom":
      return "Reply with the review instructions.";
    default:
      return "Reply with the value for this review target.";
  }
}

function collaborationModeOptions(
  modes: unknown[],
  currentModeName: string | null,
): Array<{ label: string; value: string }> {
  return modes
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const mode = entry as JsonObject;
      const name = asString(mode.name);
      if (!name) {
        return null;
      }
      const modeKind = asString(mode.mode);
      const model = asString(mode.model);
      const current = currentModeName === name ? " (current)" : "";
      const details = [modeKind, model].filter(Boolean).join(", ");
      return {
        label: details ? `${name}${current} [${details}]` : `${name}${current}`,
        value: name,
      };
    })
    .filter((entry): entry is { label: string; value: string } => Boolean(entry));
}

function formatThreadOptionLabel(thread: JsonObject, currentThreadId: string | null): string {
  const id = asString(thread.id) ?? "unknown";
  const nickname = asString(thread.agentNickname);
  const role = asString(thread.agentRole);
  const name = asString(thread.name);
  const preview = asString(thread.preview);
  const label =
    name
    ?? (nickname && role ? `${nickname} [${role}]` : nickname ?? role ?? preview ?? id);
  return `${label}${currentThreadId === id ? " (current)" : ""}`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
