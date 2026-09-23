import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiGet, apiPost } from '../api/client';
import type { JobRow } from '../api/types';
import { JobStatusBadge } from '../components/JobStatusBadge';
import { useJobStream } from '../api/useJobStream';
import { PageDescription } from '../components/PageDescription';

const CANCELLABLE_STATUSES = ['queued', 'running', 'awaiting_input'];

export function JobView() {
  const { id } = useParams<{ id: string }>();
  const jobId = Number(id);
  const [job, setJob] = useState<JobRow | null>(null);
  const { lines, liveStatus, connected, promptText, expectedPrompts, promptOrigin, promptMatchedIndex } = useJobStream(jobId);
  const logRef = useRef<HTMLPreElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);

  useEffect(() => {
    setCancelling(false);
    setCancelError(null);
    apiGet<{ job: JobRow; log: string }>(`/jobs/${jobId}`).then((data) => setJob(data.job));
  }, [jobId]);

  useEffect(() => {
    if (liveStatus && job) setJob({ ...job, status: liveStatus as JobRow['status'] });
  }, [liveStatus]);

  useEffect(() => {
    setAnswerText('');
    setPromptError(null);
  }, [promptText]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [lines]);

  if (!job) return <div className="content">Loading…</div>;

  const cancelJob = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await apiPost(`/jobs/${jobId}/cancel`, {});
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
      setCancelling(false);
    }
  };

  const submitAnswer = async (text: string) => {
    setPromptBusy(true);
    setPromptError(null);
    try {
      await apiPost(`/jobs/${jobId}/answer`, { text });
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setPromptBusy(false);
    }
  };

  const dismissPrompt = async () => {
    setPromptBusy(true);
    setPromptError(null);
    try {
      await apiPost(`/jobs/${jobId}/dismiss-prompt`, {});
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setPromptBusy(false);
    }
  };

  return (
    <div className="job-view">
      <PageDescription>
        Output for this job. Streams live over WebSocket while it's running; once finished, this is the saved log
        read back from disk.
      </PageDescription>
      <div className="job-header">
        <div>
          <div className="job-title">
            {job.command}
            {job.target ? ` · ${job.target}` : ''}
          </div>
          <div className="job-subtitle">job #{job.id}</div>
        </div>
        <div className="job-header-actions">
          <JobStatusBadge status={job.status} />
          {CANCELLABLE_STATUSES.includes(job.status) && (
            <button className="button button-danger" onClick={cancelJob} disabled={cancelling}>
              {cancelling ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>
      </div>
      {cancelError && <div className="warning-banner">{cancelError}</div>}
      {job.status === 'awaiting_input' && promptText && (
        <div className="prompt-banner">
          <div className="prompt-banner-text">{promptText}</div>
          {promptOrigin === 'expected' && (
            <div className="prompt-banner-hint">
              {promptMatchedIndex !== null && expectedPrompts.length > 0
                ? `Question ${promptMatchedIndex + 1} of up to ${expectedPrompts.length} — matches a known prompt in this app's install script.`
                : "Matches a known prompt in this app's install script."}
            </div>
          )}
          {promptOrigin === 'stall' && (
            <div className="prompt-banner-hint prompt-banner-hint-stall">
              Output stopped for 5 minutes and this does not match any known prompt — it may not be a question at all. The
              line above is the last output received. Dismiss to keep waiting, or answer if it is in fact a prompt.
            </div>
          )}
          {promptError && <div className="warning-banner">{promptError}</div>}
          <div className={promptOrigin === 'stall' ? 'prompt-banner-actions prompt-banner-actions-stall' : 'prompt-banner-actions'}>
            <button className="button" disabled={promptBusy} onClick={() => submitAnswer('y')}>
              Yes
            </button>
            <button className="button" disabled={promptBusy} onClick={() => submitAnswer('n')}>
              No
            </button>
            <form
              className="prompt-banner-freetext"
              onSubmit={(e) => {
                e.preventDefault();
                if (answerText.trim()) submitAnswer(answerText);
              }}
            >
              <input
                type="text"
                value={answerText}
                onChange={(e) => setAnswerText(e.target.value)}
                placeholder="Type an answer…"
                disabled={promptBusy}
              />
              <button className="button" type="submit" disabled={promptBusy || !answerText.trim()}>
                Submit
              </button>
            </form>
            <button className="button" disabled={promptBusy} onClick={dismissPrompt}>
              Not stuck — keep waiting
            </button>
          </div>
        </div>
      )}
      {!connected && (job.status === 'running' || job.status === 'queued' || job.status === 'awaiting_input') && (
        <p className="page-description">Live stream disconnected — checking for updates every 2 seconds.</p>
      )}
      <pre className="preview-pane job-log" ref={logRef}>
        {lines.join('\n')}
      </pre>
    </div>
  );
}
