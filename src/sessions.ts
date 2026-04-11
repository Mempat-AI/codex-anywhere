const SESSIONS_PREFIX = "ses";

export type SessionAction =
  | "takeover"
  | "status"
  | "confirmSwitch"
  | "cancelSwitch"
  | "more";

export function formatSessionCallbackData(
  action: SessionAction,
  value: string,
): string {
  return `${SESSIONS_PREFIX}:${action}:${value}`;
}

export function parseSessionCallbackData(
  data: string,
): { action: SessionAction; value: string } | null {
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== SESSIONS_PREFIX) {
    return null;
  }
  const action = parts[1];
  const value = parts[2];
  if (
    !value
    || (action !== "takeover"
      && action !== "status"
      && action !== "confirmSwitch"
      && action !== "cancelSwitch"
      && action !== "more")
  ) {
    return null;
  }
  return {
    action,
    value,
  };
}
