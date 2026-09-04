import type { BrainDb, ContentScheduleDueRow } from "../database/db.js";
import { publishSuggestion } from "./approval.js";

const runningDatabases = new WeakSet<BrainDb>();

/**
 * 🗓 CONTENT SCHEDULER — publishes approved suggestions at their scheduled time.
 * Runs on the same background cadence as the market poller (one tick per
 * minute is enough). Only opt-in: nothing reaches the scheduler unless an
 * admin approved it (manually or via auto-publish).
 */

export interface SchedulerDeps {
  db: BrainDb;
  /** Typed send surface — features never import the Bot instance directly. */
  post: (chatId: number, text: string) => Promise<boolean>;
  /** Notify the admin when a publish fails so nothing is silently lost. */
  notifyAdmin?: (chatId: number, text: string) => Promise<void>;
}

export interface SchedulerRun {
  published: number;
  failed: number;
}

/** Publish every due pending job. Idempotent per tick: jobs are marked done/missed. */
export async function runScheduler(deps: SchedulerDeps, now = Math.floor(Date.now() / 1000)): Promise<SchedulerRun> {
  if (runningDatabases.has(deps.db)) return { published: 0, failed: 0 };
  runningDatabases.add(deps.db);
  try {
    const due = deps.db.listDueContentSchedule(now);
    const run: SchedulerRun = { published: 0, failed: 0 };
    for (const job of due) {
      const res = await publishSuggestion(deps.db, job.suggestion_id, deps.post, job.id, job.chat_id);
      if (res.ok) {
        run.published++;
      } else if (res.reason === "not_ready" || res.reason === "not_found" || res.reason === "wrong_chat") {
        // Suggestion was skipped/removed after scheduling — drop the job quietly.
        deps.db.setScheduleStatus(job.id, "missed");
      } else {
        run.failed++;
        deps.db.setScheduleStatus(job.id, "missed");
        if (deps.notifyAdmin) {
          await deps.notifyAdmin(job.chat_id, `⚠️ Scheduled post #${job.suggestion_id} (${job.suggestion_kind}) failed to send — it was not published.`).catch(() => {});
        }
      }
    }
    return run;
  } finally {
    runningDatabases.delete(deps.db);
  }
}

export function scheduleDueLine(job: ContentScheduleDueRow): string {
  return `#${job.suggestion_id} (${job.suggestion_kind}) due ${new Date(job.scheduled_at * 1000).toISOString()}`;
}
