import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../api/client';
import type { JobRow } from '../api/types';
import { JobStatusBadge } from '../components/JobStatusBadge';
import { PageDescription } from '../components/PageDescription';

export function JobHistory() {
  const [jobs, setJobs] = useState<JobRow[]>([]);

  useEffect(() => {
    apiGet<JobRow[]>('/jobs').then(setJobs);
  }, []);

  return (
    <div>
      <h2>Jobs &amp; History</h2>
      <PageDescription>
        Every command run from this UI, most recent first. Click a job to see its full live or saved output.
      </PageDescription>
      <table className="data-table">
        <thead>
          <tr>
            <th>id</th>
            <th>command</th>
            <th>target</th>
            <th>status</th>
            <th>started</th>
            <th>triggered by</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td data-label="id">
                <Link to={`/jobs/${job.id}`}>#{job.id}</Link>
              </td>
              <td data-label="command">{job.command}</td>
              <td data-label="target">{job.target}</td>
              <td data-label="status">
                <JobStatusBadge status={job.status} />
              </td>
              <td data-label="started">{job.startedAt}</td>
              <td data-label="triggered by">
                {job.triggeredByUsername
                  ? job.triggeredByImpersonating
                    ? `${job.triggeredByUsername} (as: ${job.triggeredByImpersonating})`
                    : job.triggeredByUsername
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
