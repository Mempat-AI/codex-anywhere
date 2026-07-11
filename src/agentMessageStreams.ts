export function agentStreamKey(threadId: string, turnId: string, streamGroupId: string): string {
  return `${threadId}:${turnId}:${streamGroupId}`;
}

export function streamGroupId(itemId: string, _phase: string | null): string {
  return itemId;
}
