/** Recent tasks with their logs, and the app's own log file. */
import { useCallback, useEffect, useState } from "react";

import type { JobInfo } from "../../shared/events";
import { appLogUrl, getJobLog, getJobs } from "../api/client";
import { useApp } from "../state/app";
import { Modal, plural, timeAgo } from "./common";

const STATUS_TEXT: Record<JobInfo["status"], string> = { running: "Running", done: "Done", error: "Failed", cancelled: "Cancelled" };

export function HistoryTab() {
  const { toast, busy } = useApp();
  const [jobs, setJobs] = useState<JobInfo[] | null>(null);
  const [viewing, setViewing] = useState<{ job: JobInfo; text: string | null } | null>(null);

  const load = useCallback(() => {
    getJobs().then(
      (result) => setJobs(result.jobs),
      (error: Error) => toast(error.message, true),
    );
  }, [toast]);

  // Re-read whenever a task starts or ends.
  useEffect(load, [load, busy]);

  async function view(job: JobInfo) {
    setViewing({ job, text: null });
    try {
      const text = await getJobLog(job.id);
      setViewing({ job, text });
    } catch (error) {
      setViewing({ job, text: `Could not read the log: ${(error as Error).message}` });
    }
  }

  return (
    <section className="panel">
      <div className="toolbar">
        <p className="muted small grow">The last 30 tasks since the app started. Every log is also kept in run/logs.</p>
        <button className="btn sm ghost" onClick={load}>
          Refresh
        </button>
        <a className="btn sm" href={appLogUrl()} download>
          Download app log
        </a>
      </div>
      <div className="table-box">
        <table className="packs history">
          <thead>
            <tr>
              <th>Task</th>
              <th>Result</th>
              <th>Started</th>
              <th>Took</th>
              <th>
                <span className="sr">Log</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs === null && (
              <tr>
                <td colSpan={5} className="empty">
                  Reading…
                </td>
              </tr>
            )}
            {jobs?.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  Nothing has run yet.
                </td>
              </tr>
            )}
            {jobs?.map((job) => (
              <tr key={job.id}>
                <td>
                  <b>{job.title}</b>
                  {job.error && <div className="muted small">{job.error}</div>}
                </td>
                <td>
                  <span className={`status job-${job.status}`}>{STATUS_TEXT[job.status]}</span>
                  {job.warnings.length > 0 && <div className="version-note">{plural(job.warnings.length, "warning")}</div>}
                </td>
                <td className="muted">{timeAgo(job.startedAt)}</td>
                <td className="mono small">{job.finishedAt ? `${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s` : "…"}</td>
                <td className="row-actions">
                  <button className="btn xs ghost" onClick={() => void view(job)}>
                    View log
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {viewing && (
        <Modal title={viewing.job.title} onClose={() => setViewing(null)}>
          <pre className="log-view">{viewing.text ?? "Reading…"}</pre>
          <div className="row end">
            <button className="btn" onClick={() => setViewing(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
