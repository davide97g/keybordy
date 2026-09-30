/**
 * The panel that reports a flash to the real board, over the simulator
 * canvas. It shares the compile card's frame (CompileProgressCard.css) and
 * adds a row of step keycaps: Build, Connect, Write, Verify, Boot. Each cap
 * presses into its skirt when its step is done, the current one keeps
 * getting pressed, and a failed one turns pink.
 *
 * Same honesty rules as the compile card: the bar only fills while bytes
 * are being written (esptool-js reports them). Every other step shows the
 * travelling sliver. The run ends on the board's own first line after the
 * reset when it prints one, which is the proof the flash took.
 */

import { useEffect, useState } from 'react';

import { useDeviceStore, type FlashStage } from '../../store/useDeviceStore';
import { LogoSticker } from '../ui/LogoSticker';

import './CompileProgressCard.css';
import './FlashProgressCard.css';

const STEPS: { stage: FlashStage; label: string }[] = [
  { stage: 'build', label: 'Build' },
  { stage: 'connect', label: 'Connect' },
  { stage: 'write', label: 'Write' },
  { stage: 'verify', label: 'Verify' },
  { stage: 'boot', label: 'Boot' },
];

/** Where each run stage sits on the step row (`reset` shares Boot). */
const STEP_INDEX: Record<FlashStage, number> = {
  build: 0,
  connect: 1,
  write: 2,
  verify: 3,
  reset: 4,
  boot: 4,
  done: 5,
  error: -1,
};

interface FlashProgressCardProps {
  inEditor?: boolean;
}

export function FlashProgressCard({ inEditor }: FlashProgressCardProps) {
  const run = useDeviceStore((s) => s.flash);
  const portLabel = useDeviceStore((s) => s.portLabel);
  const dismiss = useDeviceStore((s) => s.dismissFlash);
  const focusMonitor = useDeviceStore((s) => s.focusMonitor);
  const [now, setNow] = useState(() => Date.now());
  const [hiddenRun, setHiddenRun] = useState<number | null>(null);

  const active = !!run && run.finishedAt === null;
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);

  if (!run || hiddenRun === run.runId) return null;

  const failed = run.stage === 'error';
  const done = run.stage === 'done';
  const settled = failed || done;
  // The step the run was on: for an error, the last stage it reached.
  const reached = failed ? STEP_INDEX[run.stages[run.stages.length - 1] ?? 'build'] : STEP_INDEX[run.stage];
  const writing = run.stage === 'write' && run.progress !== null;
  const percent = Math.round((run.progress ?? 0) * 100);
  const elapsed = Math.max(0, ((run.finishedAt ?? now) - run.startedAt) / 1000);
  const chip = run.chip?.replace(/\s*\(.*\)$/, '') ?? 'ESP32';

  const title = failed
    ? 'Flash failed'
    : done
      ? `Flashed to ${chip}`
      : run.stage === 'build'
        ? `Building for ${run.boardLabel}...`
        : run.stage === 'connect'
          ? `Connecting over ${portLabel || 'USB'}...`
          : run.stage === 'write'
            ? `Flashing ${chip}`
            : run.stage === 'verify'
              ? 'Verifying...'
              : 'Booting...';

  return (
    <div
      className={
        'compile-card flash-card' +
        (inEditor ? ' compile-card--in-editor' : '') +
        (done ? ' flash-card--done' : '') +
        (failed ? ' flash-card--error' : '')
      }
    >
      <span className="compile-card__sr" role="status" aria-live="polite">
        {title}
      </span>
      <LogoSticker
        key={run.runId}
        className="compile-card__sticker"
        size={46}
        state={settled ? (failed ? 'error' : 'done') : 'busy'}
      />
      <div className="compile-card__head">
        <span className="compile-card__title" aria-hidden="true">
          {title}
        </span>
        <span className="compile-card__timer" aria-hidden="true">
          {elapsed.toFixed(1)}s
        </span>
        <button
          type="button"
          className="compile-card__dismiss"
          onClick={() => (settled ? dismiss() : setHiddenRun(run.runId))}
          title={settled ? 'Close' : 'Hide (the flash keeps going)'}
          aria-label={settled ? 'Close' : 'Hide (the flash keeps going)'}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <ol className="flash-card__steps" aria-label="Flash steps">
        {STEPS.map((step, i) => {
          const skipped = step.stage === 'build' && !run.stages.includes('build');
          const state =
            failed && i === reached
              ? 'error'
              : done || i < reached
                ? skipped
                  ? 'skipped'
                  : 'done'
                : i === reached
                  ? 'active'
                  : 'todo';
          return (
            <li
              key={step.stage}
              className={`flash-card__step flash-card__step--${state}`}
              style={{ '--i': i } as React.CSSProperties}
              title={skipped ? 'Build: code unchanged, reused the last build' : step.label}
            >
              <span className="flash-card__cap" aria-hidden="true">
                {state === 'done' || state === 'skipped' ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                ) : state === 'error' ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span className="flash-card__step-label">
                {step.label}
                <span className="compile-card__sr">
                  {' '}
                  {state === 'skipped' ? 'reused' : state}
                </span>
              </span>
            </li>
          );
        })}
      </ol>

      <div
        className={
          'compile-card__bar' + (!settled && !writing ? ' compile-card__bar--indeterminate' : '')
        }
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(writing || settled ? { 'aria-valuenow': settled ? 100 : percent } : {})}
      >
        {(writing || settled) && (
          <div
            className={
              'compile-card__fill' +
              (settled ? (failed ? ' compile-card__fill--error' : ' compile-card__fill--success') : '')
            }
            style={{ width: `${settled ? 100 : percent}%` }}
          />
        )}
      </div>

      <div className="compile-card__status">
        <span
          className={'compile-card__stage' + (failed ? ' flash-card__error' : '')}
          title={run.error ?? run.lastLine}
        >
          {failed ? run.error : run.lastLine}
        </span>
        {writing && <span className="compile-card__percent">{percent}%</span>}
      </div>

      {done && run.bootLine && (
        <div className="flash-card__boot" aria-hidden="true">
          <span className="flash-card__boot-led" />
          <code>{run.bootLine}</code>
        </div>
      )}

      <div className="compile-card__foot">
        <span className="flash-card__port">
          <span className="flash-card__port-dot" aria-hidden="true" />
          {portLabel || 'USB'} · 921600 baud
        </span>
        {settled && (
          <button type="button" className="compile-card__details" onClick={focusMonitor}>
            Open monitor
          </button>
        )}
      </div>
    </div>
  );
}
