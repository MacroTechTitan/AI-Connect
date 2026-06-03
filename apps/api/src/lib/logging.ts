import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import { devLogs, systemLogs, userAuditLogs } from "../db/schema.js";

export type SystemLogLevel = "debug" | "info" | "warn" | "error" | "critical";

type LogContext = Record<string, unknown>;

// Logging must never throw and break the caller. Any DB or serialization
// failure prints to stderr and resolves null so the calling code keeps going.
function swallow(where: string, err: unknown): null {
  process.stderr.write(
    `[logging] ${where} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  return null;
}

export async function logSystem(
  level: SystemLogLevel,
  category: string,
  message: string,
  context?: LogContext,
  traceId?: string,
): Promise<string | null> {
  try {
    const [row] = await getDb()
      .insert(systemLogs)
      .values({
        level,
        category,
        message,
        context: context ?? null,
        traceId: traceId ?? randomUUID(),
      })
      .returning({ id: systemLogs.id });
    return row?.id ?? null;
  } catch (err) {
    return swallow("logSystem", err);
  }
}

// User actions are written to BOTH userAuditLogs (the audit trail) and
// systemLogs (the unified ops view) inside one transaction so they share a
// traceId and either both land or neither does. Returns the audit row id.
//
// organizationId was added in Sprint 3.5 to populate the column that the
// Sprint 3 schema introduced on both tables. Callers that have the acting
// user's org in scope should pass it so future org-scoped audit queries
// (Sprint 7 dashboard) line up. Callers without ctx pass null.
export async function logUserAction(
  userId: string,
  action: string,
  targetType?: string,
  targetId?: string,
  organizationId?: string | null,
  context?: LogContext,
  traceId?: string,
): Promise<string | null> {
  const trace = traceId ?? randomUUID();
  const orgId = organizationId ?? null;
  try {
    return await getDb().transaction(async (tx) => {
      const [audit] = await tx
        .insert(userAuditLogs)
        .values({
          userId,
          action,
          targetType: targetType ?? null,
          targetId: targetId ?? null,
          organizationId: orgId,
          context: context ?? null,
          traceId: trace,
        })
        .returning({ id: userAuditLogs.id });

      await tx.insert(systemLogs).values({
        level: "info",
        category: "user_action",
        message: action,
        organizationId: orgId,
        context: {
          userId,
          targetType: targetType ?? null,
          targetId: targetId ?? null,
          organizationId: orgId,
          ...(context ?? {}),
        },
        traceId: trace,
      });

      return audit?.id ?? null;
    });
  } catch (err) {
    return swallow("logUserAction", err);
  }
}

export async function logDev(
  source: string,
  category: string,
  message: string,
  context?: LogContext,
  traceId?: string,
): Promise<string | null> {
  try {
    const [row] = await getDb()
      .insert(devLogs)
      .values({
        source,
        category,
        message,
        context: context ?? null,
        traceId: traceId ?? randomUUID(),
      })
      .returning({ id: devLogs.id });
    return row?.id ?? null;
  } catch (err) {
    return swallow("logDev", err);
  }
}
