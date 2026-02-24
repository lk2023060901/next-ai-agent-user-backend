import { CronJob } from "cron";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db";
import { scheduledTasks, taskExecutions } from "../../db/schema";

// In-memory registry of running cron jobs
const runningJobs = new Map<string, CronJob>();

// ─── Task CRUD ────────────────────────────────────────────────────────────────

export function listTasks(workspaceId: string) {
  return db.select().from(scheduledTasks).where(eq(scheduledTasks.workspaceId, workspaceId)).all();
}

export function createTask(data: {
  workspaceId: string;
  name: string;
  instruction?: string;
  scheduleType: "cron" | "once";
  cronExpression?: string;
  runAt?: string;
  maxRuns?: number;
  targetAgentId?: string;
}) {
  const id = uuidv4();
  db.insert(scheduledTasks).values({
    id,
    workspaceId: data.workspaceId,
    name: data.name,
    instruction: data.instruction ?? null,
    scheduleType: data.scheduleType,
    cronExpression: data.cronExpression ?? null,
    runAt: data.runAt ?? null,
    maxRuns: data.maxRuns ?? null,
    targetAgentId: data.targetAgentId ?? null,
  }).run();

  const task = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get()!;
  scheduleTask(task);
  return task;
}

export function updateTask(taskId: string, data: {
  name?: string;
  instruction?: string;
  scheduleType?: string;
  cronExpression?: string;
  runAt?: string;
  maxRuns?: number;
  targetAgentId?: string;
  status?: string;
}) {
  const task = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).get();
  if (!task) throw Object.assign(new Error("Task not found"), { code: "NOT_FOUND" });

  // Stop existing job before rescheduling
  stopJob(taskId);

  db.update(scheduledTasks).set({
    ...(data.name && { name: data.name }),
    ...(data.instruction !== undefined && { instruction: data.instruction }),
    ...(data.scheduleType && { scheduleType: data.scheduleType }),
    ...(data.cronExpression !== undefined && { cronExpression: data.cronExpression }),
    ...(data.runAt !== undefined && { runAt: data.runAt }),
    ...(data.maxRuns !== undefined && { maxRuns: data.maxRuns }),
    ...(data.targetAgentId !== undefined && { targetAgentId: data.targetAgentId }),
    ...(data.status && { status: data.status }),
  }).where(eq(scheduledTasks.id, taskId)).run();

  const updated = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).get()!;
  if (updated.status === "active") scheduleTask(updated);
  return updated;
}

export function deleteTask(taskId: string) {
  const task = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).get();
  if (!task) throw Object.assign(new Error("Task not found"), { code: "NOT_FOUND" });
  stopJob(taskId);
  db.delete(scheduledTasks).where(eq(scheduledTasks.id, taskId)).run();
}

// ─── Executions ───────────────────────────────────────────────────────────────

export function listExecutions(taskId: string, limit = 20) {
  return db
    .select()
    .from(taskExecutions)
    .where(eq(taskExecutions.taskId, taskId))
    .all()
    .slice(-limit);
}

export async function runTask(taskId: string): Promise<typeof taskExecutions.$inferSelect> {
  const task = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).get();
  if (!task) throw Object.assign(new Error("Task not found"), { code: "NOT_FOUND" });
  return executeTask(task);
}

// ─── Cron Engine ──────────────────────────────────────────────────────────────

function scheduleTask(task: typeof scheduledTasks.$inferSelect) {
  if (task.status !== "active") return;

  if (task.scheduleType === "once") {
    if (!task.runAt) return;
    const runDate = new Date(task.runAt);
    if (runDate <= new Date()) return; // already past

    const job = new CronJob(runDate, async () => {
      await executeTask(task);
      job.stop();
      runningJobs.delete(task.id);
    });
    job.start();
    runningJobs.set(task.id, job);
    return;
  }

  // cron type
  if (!task.cronExpression) return;

  const job = new CronJob(task.cronExpression, async () => {
    const current = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, task.id)).get();
    if (!current || current.status !== "active") { job.stop(); runningJobs.delete(task.id); return; }

    await executeTask(current);

    // Check max runs
    const updated = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, task.id)).get()!;
    if (updated.maxRuns && updated.runCount >= updated.maxRuns) {
      db.update(scheduledTasks).set({ status: "completed" }).where(eq(scheduledTasks.id, task.id)).run();
      job.stop();
      runningJobs.delete(task.id);
    }
  });
  job.start();
  runningJobs.set(task.id, job);
}

async function executeTask(task: typeof scheduledTasks.$inferSelect) {
  const execId = uuidv4();
  const startedAt = new Date().toISOString();

  db.insert(taskExecutions).values({
    id: execId,
    taskId: task.id,
    status: "running",
    startedAt,
  }).run();

  // Increment run count
  db.update(scheduledTasks)
    .set({ runCount: (task.runCount ?? 0) + 1 })
    .where(eq(scheduledTasks.id, task.id))
    .run();

  try {
    // TODO: dispatch to Agent when chat module is implemented
    // For now, log the instruction
    console.log(`[Scheduler] Executing task "${task.name}": ${task.instruction}`);

    const endedAt = new Date().toISOString();
    db.update(taskExecutions).set({
      status: "success",
      endedAt,
      result: JSON.stringify({ message: "executed", instruction: task.instruction }),
    }).where(eq(taskExecutions.id, execId)).run();

  } catch (err: any) {
    db.update(taskExecutions).set({
      status: "failed",
      endedAt: new Date().toISOString(),
      result: JSON.stringify({ error: err.message }),
    }).where(eq(taskExecutions.id, execId)).run();
  }

  return db.select().from(taskExecutions).where(eq(taskExecutions.id, execId)).get()!;
}

function stopJob(taskId: string) {
  const job = runningJobs.get(taskId);
  if (job) { job.stop(); runningJobs.delete(taskId); }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
// Call on server startup to restore active tasks from DB

export function bootstrapScheduler() {
  const activeTasks = db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.status, "active"))
    .all();

  for (const task of activeTasks) {
    scheduleTask(task);
  }
  console.log(`[Scheduler] Restored ${activeTasks.length} active tasks`);
}
