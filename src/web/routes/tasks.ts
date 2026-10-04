import { Router } from 'express';
import { z } from 'zod';
import { requireAdminGroup } from '../auth.ts';
import { resolveTriggeredBy } from '../impersonation.ts';
import { UnknownTaskError, type TaskScheduler } from '../tasks/scheduler.ts';

// contracts/http-api.md's PATCH body: strict (an unknown key is a 400, not
// silently ignored) and at least one of the two fields -- an empty body is
// rejected rather than treated as a no-op save.
const PatchTaskBodySchema = z
  .object({
    timeOfDay: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.timeOfDay !== undefined || body.enabled !== undefined, {
    message: 'At least one of timeOfDay or enabled is required',
  });

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// GET/PATCH /api/tasks(/:id), POST /api/tasks/:id/run (contracts/http-api.md,
// FR-007..FR-011). `taskScheduler` is undefined in any process that never
// constructs one (every test that doesn't care, and the CLI/MCP server,
// which never reach this router at all) -- every route answers 503 rather
// than throwing on a missing scheduler.
export function tasksRoutes(taskScheduler: TaskScheduler | undefined): Router {
  const router = Router();
  router.use(requireAdminGroup);
  router.use((_req, res, next) => {
    if (!taskScheduler) {
      res.status(503).json({ error: 'Task scheduler is not running in this process' });
      return;
    }
    next();
  });

  router.get('/', (_req, res) => {
    res.json({ tasks: taskScheduler!.listTasks() });
  });

  router.patch('/:id', (req, res) => {
    const parsed = PatchTaskBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
      return;
    }
    try {
      res.json(taskScheduler!.updateSchedule(req.params.id, parsed.data));
    } catch (err) {
      if (err instanceof UnknownTaskError) {
        res.status(404).json({ error: err.message });
        return;
      }
      // The only other thrown error is TIME_OF_DAY_ERROR (a malformed
      // timeOfDay the zod schema above can't catch, since it only knows the
      // field is a string) -- a client-side mistake, not a server error.
      res.status(400).json({ error: errMsg(err) });
    }
  });

  router.post('/:id/run', (req, res) => {
    try {
      const result = taskScheduler!.startRun(req.params.id, resolveTriggeredBy(req));
      if ('alreadyRunning' in result) {
        // Known-id by construction: startRun already resolved the task
        // before returning this result, so getTask can't itself 404 here.
        const task = taskScheduler!.getTask(req.params.id);
        res.status(409).json({ error: `${task.label} is already running (job #${result.alreadyRunning})` });
        return;
      }
      res.json({ jobId: result.jobId });
    } catch (err) {
      if (err instanceof UnknownTaskError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
