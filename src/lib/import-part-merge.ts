/**
 * Data pack import: a pack is the source of truth for the part it carries.
 * We locate the existing part (same id, same title, or same part number) and
 * REPLACE it wholesale — every previously saved scene/timing of that part is
 * dropped so nothing from the old version can conflict with the pack.
 */

type AnyPart = Record<string, unknown>;

function normTitle(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function partNumber(v: unknown): number | null {
  const m = /(?:^|\bpart\s*)(\d+)/i.exec(String(v ?? ""));
  return m ? Number(m[1]) : null;
}

/** Index of the existing part this pack should overwrite, or -1 to append. */
export function findImportTargetIndex(
  parts: AnyPart[],
  incoming: AnyPart,
): number {
  const byId = parts.findIndex((p) => p.id === incoming.id);
  if (byId >= 0) return byId;
  const title = normTitle(incoming.title);
  if (title) {
    const byTitle = parts.findIndex((p) => normTitle(p.title) === title);
    if (byTitle >= 0) return byTitle;
  }
  const num = partNumber(incoming.title);
  if (num != null) {
    const byNum = parts.findIndex((p) => partNumber(p.title) === num);
    if (byNum >= 0) return byNum;
  }
  return -1;
}

/**
 * Build the replacement part: pack content wins entirely, but we keep the
 * existing part id (so saved links keep working) and its assignment.
 */
export function buildImportedPart(
  existing: AnyPart | undefined,
  incoming: AnyPart,
  now: string,
): AnyPart {
  const next: AnyPart = { ...incoming, updated_at: now };
  if (existing) {
    next.id = existing.id;
    if (incoming.assignedUserId == null && incoming.assignedUserEmail == null) {
      next.assignedUserId = existing.assignedUserId ?? null;
      next.assignedUserEmail = existing.assignedUserEmail ?? null;
    }
    if (existing.created_at) next.created_at = existing.created_at;
  }
  return next;
}
