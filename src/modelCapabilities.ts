import type { JsonObject } from "./types.js";

export interface ReasoningEffortOption {
  value: string;
  label: string;
  description: string | null;
}

export function modelName(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return asString((entry as JsonObject).model) ?? asString((entry as JsonObject).id);
}

export function modelReasoningEfforts(entry: unknown): ReasoningEffortOption[] | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const model = entry as JsonObject;
  const raw =
    model.supportedReasoningEfforts
    ?? model.supported_reasoning_efforts
    ?? model.reasoningEfforts
    ?? model.reasoning_efforts;
  if (!Array.isArray(raw)) {
    return null;
  }

  const seen = new Set<string>();
  const options: ReasoningEffortOption[] = [];
  for (const item of raw) {
    const value = normalizeReasoningEffortValue(
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? asString((item as JsonObject).reasoningEffort)
            ?? asString((item as JsonObject).reasoning_effort)
            ?? asString((item as JsonObject).value)
            ?? asString((item as JsonObject).id)
            ?? asString((item as JsonObject).name)
          : null,
    );
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    options.push({
      value,
      label: formatReasoningEffortLabel(value),
      description: item && typeof item === "object" ? asString((item as JsonObject).description) : null,
    });
  }
  return options;
}

export function findModelEntry(models: unknown[], model: string): unknown | null {
  return models.find((entry) => modelName(entry) === model) ?? null;
}

export function normalizeReasoningEffortValue(value: unknown): string | null {
  const text = asString(value);
  if (!text) {
    return null;
  }
  return text.trim().toLowerCase().replace(/[-_\s]+/g, "");
}

export function formatReasoningEffortLabel(value: string): string {
  if (value === "xhigh") {
    return "X-High";
  }
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export function reasoningEffortUsageForModel(entry: unknown): string {
  const efforts = modelReasoningEfforts(entry);
  if (!efforts) {
    return "no advertised reasoning-effort options";
  }
  if (efforts.length === 0) {
    return "default only";
  }
  return efforts.map((effort) => effort.value).join("|");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
