import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { apiGet, apiPatch, apiPost } from '../api/client';
import type { TaskView } from '../api/types';
import { PageDescription } from '../components/PageDescription';
import { JobStatusBadge } from '../components/JobStatusBadge';
import { isValidTimeOfDay, lastRunText, nextRunText, taskStatusLabel } from '../lib/task-display';

// Browser-local time, per research R11 -- never UTC/ISO shown raw.
function formatLocalTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

interface TaskDraft {
  timeOfDay: string;
  enabled: boolean;
  saving: boolean;
  running: boolean;
  error: string | null;
}

function draftFor(task: TaskView): TaskDraft {
  return { timeOfDay: task.timeOfDay, enabled: task.enabled, saving: false, running: false, error: null };
}

export function TasksPage() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [drafts, setDrafts] = useState<Record<string, TaskDraft>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Replaces every row's draft with the server's own values, except each
  // row's own in-flight error -- a reload must not silently clear a message
  // the admin hasn't seen yet.
  const applyTasks = (list: TaskView[]) => {
    setTasks(list);
    setDrafts((prev) => {
      const next: Record<string, TaskDraft> = {};
      for (const task of list) next[task.id] = { ...draftFor(task), error: prev[task.id]?.error ?? null };
      return next;
    });
  };

  const reload = () =>
    apiGet<{ tasks: TaskView[] }>('/tasks')
      .then((res) => {
        applyTasks(res.tasks);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const setDraft = (taskId: string, patch: Partial<TaskDraft>) =>
    setDrafts((prev) => ({ ...prev, [taskId]: { ...(prev[taskId] ?? { ...draftFor(tasks.find((t) => t.id === taskId)!) }), ...patch } }));

  const save = async (task: TaskView) => {
    const draft = drafts[task.id] ?? draftFor(task);
    if (!isValidTimeOfDay(draft.timeOfDay)) {
      setDraft(task.id, { error: 'timeOfDay must be HH:MM in 24-hour time, e.g. 04:00' });
      return;
    }
    setDraft(task.id, { saving: true, error: null });
    try {
      const updated = await apiPatch<TaskView>(`/tasks/${task.id}`, {
        timeOfDay: draft.timeOfDay,
        enabled: draft.enabled,
      });
      setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
      setDrafts((prev) => ({ ...prev, [task.id]: { ...draftFor(updated), error: null } }));
    } catch (err) {
      setDraft(task.id, { saving: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const runNow = async (task: TaskView) => {
    setDraft(task.id, { running: true, error: null });
    try {
      const res = await apiPost<{ jobId: number }>(`/tasks/${task.id}/run`, {});
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setDraft(task.id, { running: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (loading) return <p>Loading...</p>;

  return (
    <div>
      <h2>Tasks</h2>
      <PageDescription>
        Scheduled background tasks this service runs on its own. Change when a task runs, turn it off, or run it
        right now.
      </PageDescription>
      {loadError && <div className="warning-banner">{loadError}</div>}
      <table className="data-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Schedule</th>
            <th>Last run</th>
            <th>Next run</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const draft = drafts[task.id] ?? draftFor(task);
            return (
              <tr key={task.id}>
                <td data-label="Task" className="task-cell">
                  <div>
                    <strong>{task.label}</strong>
                    <p className="task-description">{task.description}</p>
                  </div>
                </td>
                <td data-label="Schedule" className="task-cell">
                  <div>
                    <div className="actions-cell">
                      <input
                        type="time"
                        className="field-input"
                        value={draft.timeOfDay}
                        onChange={(e) => setDraft(task.id, { timeOfDay: e.target.value })}
                      />
                      <label className="task-enabled-label">
                        <input
                          type="checkbox"
                          checked={draft.enabled}
                          onChange={(e) => setDraft(task.id, { enabled: e.target.checked })}
                        />{' '}
                        Enabled
                      </label>
                      <button type="button" className="button" disabled={draft.saving} onClick={() => save(task)}>
                        {draft.saving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                    {draft.error && <p className="task-row-error">{draft.error}</p>}
                  </div>
                </td>
                <td data-label="Last run">
                  {task.lastRun ? (
                    <>
                      {task.lastRun.status ? (
                        <JobStatusBadge status={task.lastRun.status} />
                      ) : (
                        taskStatusLabel(task.lastRun.status)
                      )}{' '}
                      <Link to={`/jobs/${task.lastRun.jobId}`}>{lastRunText(task.lastRun, formatLocalTime)}</Link>
                    </>
                  ) : (
                    lastRunText(null, formatLocalTime)
                  )}
                </td>
                <td data-label="Next run">{nextRunText(task.nextRun, formatLocalTime)}</td>
                <td data-label="Actions">
                  <div className="actions-cell">
                    <button type="button" className="button" disabled={draft.running} onClick={() => runNow(task)}>
                      {draft.running ? 'Starting...' : 'Run now'}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
