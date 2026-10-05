import { useEffect, useState } from 'react';
import { SetupApiError, setupApi, type SetupState } from '../api/setup';

const STEP_LABELS: Record<string, string> = {
  proxmox: 'Proxmox',
  basics: 'Domain and basics',
  finish: 'Finish',
};

// The first-run setup walkthrough (#86). Rendered outside the app shell:
// before setup finishes nothing else is reachable, and there is no signed-in
// user for the sidebar to describe.
export function SetupPage() {
  const [state, setState] = useState<SetupState | null>(null);
  const [problem, setProblem] = useState<'unauthorized' | 'error' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setupApi
      .state()
      .then(setState)
      .catch((err: unknown) => {
        if (err instanceof SetupApiError && err.status === 404) {
          location.href = '/';
          return;
        }
        if (err instanceof SetupApiError && err.status === 401) {
          setProblem('unauthorized');
          return;
        }
        setProblem('error');
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  if (problem === 'unauthorized') {
    return (
      <main className="setup-page">
        <h1>Set up Bellhop</h1>
        <p className="page-description">
          Open the setup address from the Bellhop service log. It looks like{' '}
          <code>http://&lt;this machine&gt;:3001/setup?token=…</code> and is written every time the service
          starts until setup is finished.
        </p>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <h1>Set up Bellhop</h1>
      {error && <div className="warning-banner">{error}</div>}
      {state && (
        <ol className="setup-steps">
          {[...state.requiredSteps, 'finish'].map((step) => (
            <li key={step} className={state.completedSteps.includes(step) ? 'setup-step done' : 'setup-step'}>
              {STEP_LABELS[step] ?? step}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
