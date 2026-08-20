function dateParts(timeZone: string, value: Date): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const result: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") result[part.type] = Number(part.value);
  return result;
}

function zonedOffset(timeZone: string, value: Date): number {
  const parts = dateParts(timeZone, value);
  return (
    Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) -
    value.getTime()
  );
}

/**
 * Finds the next local daily boundary, including IANA/DST offset convergence.
 * It intentionally duplicates the portable platform helper to keep this package
 * independent of platform adapters.
 */
export function nextDailyResetMillis(nowMillis: number, timeZone: string, hour: number): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    throw new RangeError("reset hour must be 0...23");
  const now = new Date(nowMillis);
  if (!Number.isFinite(now.getTime())) throw new RangeError("now must be valid");
  const localNow = dateParts(timeZone, now);
  let localDate = new Date(Date.UTC(localNow.year!, localNow.month! - 1, localNow.day!, hour));
  let candidate = localDate.getTime() - zonedOffset(timeZone, localDate);
  candidate = localDate.getTime() - zonedOffset(timeZone, new Date(candidate));
  if (candidate <= nowMillis) {
    localDate = new Date(Date.UTC(localNow.year!, localNow.month! - 1, localNow.day! + 1, hour));
    candidate = localDate.getTime() - zonedOffset(timeZone, localDate);
    candidate = localDate.getTime() - zonedOffset(timeZone, new Date(candidate));
  }
  return candidate;
}
