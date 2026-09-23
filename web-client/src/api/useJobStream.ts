import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from './client';
import type { PromptOrigin } from './types';

const TERMINAL_STATUSES = ['success', 'failed', 'cancelled', 'interrupted'];
const POLL_INTERVAL_MS = 2000;

// Remote output can use LF (the common case, since every SSH target is
// Linux), CRLF, or a bare CR (a tool redrawing a progress line in place) --
// splitting on '\n' alone left a stray trailing '\r' on every line for the
// first two. Recognize all three as a line boundary instead.
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

// Some installers (community-scripts' whiptail-based build.func, in
// particular) genuinely emit ANSI escape sequences -- cursor moves, colors,
// alternate-screen-buffer switches -- because exporting TERM=xterm (so their
// unconditional `clear` call doesn't abort) makes them believe they have a
// real terminal. A plain <pre> has no escape-sequence interpreter, so those
// render as literal garbage. Stripped for display only -- the saved .log
// file on disk keeps the raw bytes untouched, which is what actually let
// this get diagnosed in the first place.
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Za-z0-9]|[78]|[@-Z\\^_])/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

export function useJobStream(jobId: number) {
  // Kept as one raw buffer rather than an array of already-split lines: a
  // live 'chunk' event is an arbitrary byte-boundary slice of the stream,
  // not necessarily a whole line, so splitting only happens once at render
  // time via `lines` below.
  const [text, setText] = useState('');
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [promptText, setPromptText] = useState<string | null>(null);
  const [expectedPrompts, setExpectedPrompts] = useState<string[]>([]);
  const [promptOrigin, setPromptOrigin] = useState<PromptOrigin | null>(null);
  const [promptMatchedIndex, setPromptMatchedIndex] = useState<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setText('');
    setLiveStatus(null);
    setConnected(true);
    setPromptText(null);
    setExpectedPrompts([]);
    setPromptOrigin(null);
    setPromptMatchedIndex(null);

    let stopped = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    // Fallback for when the live WebSocket drops for any reason (server
    // restart, network hiccup, proxy issue) -- without this, the UI would
    // just go silent with no way to tell whether the job finished, failed,
    // or is still running.
    const startPolling = () => {
      if (pollTimer) return;
      pollTimer = setInterval(async () => {
        try {
          const data = await apiGet<{
            job: {
              status: string;
              promptText: string | null;
              expectedPromptsJson: string | null;
              promptOrigin: PromptOrigin | null;
              promptMatchedIndex: number | null;
            };
            log: string;
          }>(`/jobs/${jobId}`);
          if (stopped) return;
          setText(data.log);
          setLiveStatus(data.job.status);
          setPromptText(data.job.status === 'awaiting_input' ? data.job.promptText : null);
          setExpectedPrompts(data.job.expectedPromptsJson ? JSON.parse(data.job.expectedPromptsJson) : []);
          setPromptOrigin(data.job.status === 'awaiting_input' ? data.job.promptOrigin : null);
          setPromptMatchedIndex(data.job.status === 'awaiting_input' ? data.job.promptMatchedIndex : null);
          if (TERMINAL_STATUSES.includes(data.job.status) && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = undefined;
          }
        } catch {
          // transient — keep trying on the next tick
        }
      }, POLL_INTERVAL_MS);
    };

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws/jobs/${jobId}`);
    socketRef.current = ws;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'backlog' && msg.text) setText(msg.text);
      if (msg.type === 'chunk') setText((prev) => prev + msg.text);
      if (msg.type === 'status') setLiveStatus(msg.status);
      if (msg.type === 'prompt') {
        setPromptText(msg.text);
        setExpectedPrompts(msg.expectedPrompts ?? []);
        setPromptOrigin(msg.origin ?? null);
        setPromptMatchedIndex(msg.matchedIndex ?? null);
      }
      if (msg.type === 'prompt-cleared') {
        setPromptText(null);
        setExpectedPrompts([]);
        setPromptOrigin(null);
        setPromptMatchedIndex(null);
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      setConnected(false);
      startPolling();
    };
    ws.onerror = () => {
      if (stopped) return;
      setConnected(false);
      startPolling();
    };

    return () => {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      ws.close();
    };
  }, [jobId]);

  const lines = useMemo(() => splitLines(stripAnsi(text)), [text]);

  return { lines, liveStatus, connected, promptText, expectedPrompts, promptOrigin, promptMatchedIndex };
}
