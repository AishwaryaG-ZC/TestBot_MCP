'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import type { TestRun } from '@/lib/types/database';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ErrorObj {
  message?: string;
  stack?: string;
  value?: string;
  callLog?: string[];
  snippet?: string;
  location?: { file?: string; line?: number; column?: number };
}

interface Attachment {
  path?: string;
  fullPath?: string;
  name?: string;
  contentType?: string;
}

interface ReportTest {
  name?: string;
  title?: string;
  status?: string;
  outcome?: string;
  duration?: number;
  duration_ms?: number;
  suite?: string;
  file?: string;
  error?: string | ErrorObj;
  error_message?: string;
  errorMessage?: string;
  message?: string;
  attachments?: {
    screenshots?: Attachment[];
    videos?: Attachment[];
    traces?: Attachment[];
    other?: Attachment[];
  };
  artifacts?: {
    screenshots?: Attachment[];
    videos?: Attachment[];
    traces?: Attachment[];
  };
}

interface ReportJson {
  metadata?: {
    projectPath?: string;
    runId?: string;
    run_id?: string;
    live?: {
      isLive?: boolean;
      phase?: string;
      status?: string;
      errorCode?: string;
      message?: string;
      reason?: string;
      generatedFiles?: string[];
      hasLiveTests?: boolean;
    };
  };
  tests?: ReportTest[];
  results?: ReportTest[];
  summary?: { total?: number; passed?: number; failed?: number; skipped?: number };
  stats?: { total?: number; passed?: number; failed?: number; skipped?: number; duration?: number };
}

interface AiAnalysisItem {
  testName?: string;
  test?: string;
  test_name?: string;
  analysis?: string;
  root_cause?: string;
  rootCause?: string;
  suggested_fix?: string;
  suggestedFix?: string;
  fix?: string;
  testingRecommendations?: string;
  testing_recommendations?: string;
  confidence?: number | string;
}

interface LiveEvent {
  id: string;
  type: string;
  phase: string | null;
  status: string | null;
  message: string | null;
  errorCode: string | null;
  reason: string | null;
  eventType: string | null;
  durationMs: number | null;
  occurredAt: string | null;
  metadata: Record<string, unknown> | null;
}

interface LiveTestResult {
  n: string;
  su: string;
  f: string;
  s: string;
  d: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safely convert any error value to a display string */
function errorToString(err: unknown): string | null {
  if (!err) return null;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as ErrorObj;
    const parts = [e.message, e.stack, e.value, e.callLog?.length ? `Call log:\n${e.callLog.join('\n')}` : null]
      .filter(Boolean);
    return parts.length > 0 ? parts.join('\n\n') : JSON.stringify(err, null, 2);
  }
  return String(err);
}

/** Safely convert any value to a renderable string */
function safeString(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    if ('message' in (val as Record<string, unknown>)) return String((val as Record<string, unknown>).message);
    return JSON.stringify(val);
  }
  return String(val);
}

function getConfidencePercent(confidence: number | string | null | undefined): number | null {
  if (confidence === null || confidence === undefined) return null;
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    return confidence > 1 ? Math.max(0, Math.min(100, Math.round(confidence))) : Math.max(0, Math.min(100, Math.round(confidence * 100)));
  }
  if (typeof confidence === 'string') {
    const trimmed = confidence.trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed.endsWith('%')) {
      const pct = Number(trimmed.replace('%', ''));
      return Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return parsed > 1 ? Math.max(0, Math.min(100, Math.round(parsed))) : Math.max(0, Math.min(100, Math.round(parsed * 100)));
  }
  return null;
}

function buildFailureInsight(errorText: string): string | null {
  const text = errorText.toLowerCase();

  if (text.includes('tohaveurl') && text.includes('/login')) {
    return 'This flow expects an authenticated route but the app redirected to /login. Seed auth state or add a login step before asserting URL.';
  }

  if (text.includes('expect(received).tocontain(expected)') && text.includes('received array')) {
    return 'Status assertion is too strict for this endpoint. Expand expected status set for validation/auth conflicts or update test data setup.';
  }

  if (text.includes('timeout') && (text.includes('locator') || text.includes('tobevisible'))) {
    return 'Element was not found before timeout. Prefer role/label selectors and wait on a stable UI state tied to data load.';
  }

  if (text.includes('econnrefused') || text.includes('failed to fetch')) {
    return 'Target server was unavailable during execution. Verify start command, base URL, and that the service is reachable before tests run.';
  }

  if (text.includes('tohaveproperty') || text.includes('unexpected token')) {
    return 'API contract assertion failed. Response payload shape/content changed and needs updated schema expectations or endpoint fix.';
  }

  return null;
}

// ─── Count-up animation hook ─────────────────────────────────────────────────

function useCountUp(target: number, duration = 1200, delay = 0) {
  const [value, setValue] = useState(0);
  const raf = useRef<number | null>(null);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    let start: number | null = null;
    const timeout = setTimeout(() => {
      if (target === from) return;
      if (target === 0) { fromRef.current = 0; setValue(0); return; }
      const step = (ts: number) => {
        if (!start) start = ts;
        const progress = Math.min((ts - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const next = Math.round(from + eased * (target - from));
        fromRef.current = next;
        setValue(next);
        if (progress < 1) raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    }, delay);

    return () => {
      clearTimeout(timeout);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, duration, delay]);

  return value;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color, delay }: {
  label: string; value: number; sub?: string; color: string; delay: number;
}) {
  const displayed = useCountUp(value, 1000, delay);
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: delay / 1000 }}
      className="glass-card rounded-2xl p-5 flex flex-col gap-1"
    >
      <span className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider">{label}</span>
      <span className={`text-3xl font-bold ${color}`}>{displayed}{sub}</span>
    </motion.div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = (status ?? '').toLowerCase();
  if (s === 'passed' || s === 'pass')
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400">passed</span>;
  if (s === 'failed' || s === 'fail')
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/10 text-red-400">failed</span>;
  if (s === 'skipped' || s === 'skip' || s === 'pending')
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400">skipped</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400">{s}</span>;
}

function StatusBar({ passed, failed, skipped, total }: { passed: number; failed: number; skipped: number; total: number }) {
  if (total === 0) return null;
  const pPct = (passed / total) * 100;
  const fPct = (failed / total) * 100;
  const sPct = (skipped / total) * 100;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-3 rounded-full overflow-hidden bg-white/5">
        <motion.div initial={{ width: 0 }} animate={{ width: `${pPct}%` }} transition={{ duration: 0.8, delay: 0.3 }} className="h-full bg-emerald-500" />
        <motion.div initial={{ width: 0 }} animate={{ width: `${fPct}%` }} transition={{ duration: 0.8, delay: 0.5 }} className="h-full bg-red-500" />
        <motion.div initial={{ width: 0 }} animate={{ width: `${sPct}%` }} transition={{ duration: 0.8, delay: 0.7 }} className="h-full bg-amber-500" />
      </div>
      <div className="flex items-center gap-4 text-xs text-[#4A6280]">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />{passed} passed</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />{failed} failed</span>
        {skipped > 0 && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />{skipped} skipped</span>}
      </div>
    </div>
  );
}

// ─── Artifact viewer components ──────────────────────────────────────────────

function ArtifactImage({ src, alt }: { src: string; alt: string }) {
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="rounded-lg border border-white/10 bg-white/5 px-3 py-4 text-left text-xs text-[#8BA4C8] hover:border-blue-500/30"
      >
        Screenshot unavailable in preview. Open file directly.
      </a>
    );
  }

  return (
    <>
      <button onClick={() => setExpanded(true)} className="relative group cursor-pointer rounded-lg overflow-hidden border border-white/10 hover:border-blue-500/40 transition-all">
        <img src={src} alt={alt} className="w-full h-32 object-cover" loading="lazy" onError={() => setFailed(true)} />
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" /></svg>
        </div>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-8"
            onClick={() => setExpanded(false)}
          >
            <motion.img
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.8 }}
              src={src}
              alt={alt}
              className="max-w-full max-h-full rounded-xl shadow-2xl border border-white/10"
              onClick={e => e.stopPropagation()}
            />
            <button onClick={() => setExpanded(false)} className="absolute top-6 right-6 text-white/60 hover:text-white transition-colors">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function ArtifactVideo({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="rounded-lg overflow-hidden border border-white/10 bg-white/5 p-3">
        <div className="text-xs text-[#8BA4C8] mb-2">Video preview unavailable for this artifact.</div>
        <ArtifactDownload src={src} label="Download Video" />
      </div>
    );
  }

  return (
    <div className="rounded-lg overflow-hidden border border-white/10">
      <video controls preload="metadata" className="w-full max-h-64" onError={() => setFailed(true)}>
        <source src={src} />
        Your browser does not support the video tag.
      </video>
    </div>
  );
}

function ArtifactDownload({ src, label }: { src: string; label: string }) {
  return (
    <a href={src} download className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 hover:border-blue-500/30 transition-all text-sm text-[#8BA4C8] hover:text-[#F0F6FF]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
      {label}
    </a>
  );
}

// ─── Normalise test from various report shapes ───────────────────────────────

interface NormalisedTest {
  name: string;
  status: string;
  duration: number | null;
  suite: string;
  error: string | null;
  errorObj: ErrorObj | null;
  screenshots: string[];
  videos: string[];
  traces: string[];
}

function normaliseTest(t: ReportTest, idx: number, testRunId: string): NormalisedTest {
  // Safely extract error
  const rawError = t.error ?? t.error_message ?? t.errorMessage ?? t.message ?? null;
  const errorStr = errorToString(rawError);
  const errorObj: ErrorObj | null = (rawError && typeof rawError === 'object') ? rawError as ErrorObj : null;

  // Collect artifact paths
  const att = t.attachments || t.artifacts || {};
  const screenshotPaths = (att.screenshots || []).map(a => a.path || a.fullPath || a.name).filter(Boolean) as string[];
  const videoPaths = (att.videos || []).map(a => a.path || a.fullPath || a.name).filter(Boolean) as string[];
  const tracePaths = (att.traces || []).map(a => a.path || a.fullPath || a.name).filter(Boolean) as string[];

  // Build artifact URLs
  const toUrl = (p: string) => `/api/artifacts?testRunId=${testRunId}&file=${encodeURIComponent(p)}`;

  return {
    name: t.name ?? t.title ?? `Test ${idx + 1}`,
    status: t.status ?? t.outcome ?? 'unknown',
    duration: t.duration ?? t.duration_ms ?? null,
    suite: t.suite ?? t.file ?? '—',
    error: errorStr,
    errorObj,
    screenshots: screenshotPaths.map(toUrl),
    videos: videoPaths.map(toUrl),
    traces: tracePaths.map(toUrl),
  };
}

// ─── Expandable test row ─────────────────────────────────────────────────────

function TestRow({ t, idx }: { t: NormalisedTest; idx: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = !!(t.error || t.screenshots.length || t.videos.length || t.traces.length || t.errorObj);
  const isFailed = ['failed', 'fail'].includes(t.status.toLowerCase());
  const failureInsight = t.error ? buildFailureInsight(t.error) : null;

  return (
    <>
      <motion.tr
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 + idx * 0.02 }}
        className={`border-b border-white/5 last:border-0 transition-all ${hasDetails ? 'cursor-pointer hover:bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        <td className="px-6 py-3">
          <div className="flex items-center gap-2">
            {hasDetails && (
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className={`flex-shrink-0 text-[#4A6280] transition-transform ${expanded ? 'rotate-90' : ''}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            )}
            <div>
              <div className="text-[#F0F6FF] text-sm font-medium">{t.name}</div>
              {isFailed && t.error && !expanded && (
                <div className="text-red-400/70 text-xs mt-0.5 font-mono truncate max-w-xs">
                  {t.error.length > 100 ? t.error.slice(0, 100) + '...' : t.error}
                </div>
              )}
            </div>
          </div>
        </td>
        <td className="px-4 py-3">
          <span className="text-[#4A6280] text-xs font-mono truncate max-w-[160px] block">{t.suite}</span>
        </td>
        <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
        <td className="px-4 py-3">
          <span className="text-[#4A6280] text-xs font-mono">
            {t.duration !== null ? `${(t.duration / 1000).toFixed(2)}s` : '—'}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            {t.screenshots.length > 0 && (
              <span title={`${t.screenshots.length} screenshot(s)`} className="w-5 h-5 rounded bg-blue-500/10 flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
              </span>
            )}
            {t.videos.length > 0 && (
              <span title={`${t.videos.length} video(s)`} className="w-5 h-5 rounded bg-purple-500/10 flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
              </span>
            )}
            {t.traces.length > 0 && (
              <span title={`${t.traces.length} trace(s)`} className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
              </span>
            )}
          </div>
        </td>
      </motion.tr>

      {/* Expanded details */}
      <AnimatePresence>
        {expanded && (
          <motion.tr
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <td colSpan={5} className="px-6 pb-4">
              <div className="ml-5 flex flex-col gap-4 pt-1">
                {/* Error details */}
                {t.error && (
                  <div className="rounded-xl bg-red-500/5 border border-red-500/15 p-4">
                    <div className="text-red-400 text-xs font-semibold uppercase tracking-wider mb-2">Error</div>
                    {failureInsight && (
                      <div className="mb-3 rounded-lg border border-red-500/20 bg-red-500/5 p-2.5">
                        <div className="text-red-300 text-[11px] font-semibold uppercase tracking-wider mb-1">Likely Cause</div>
                        <div className="text-red-200/90 text-xs leading-relaxed">{failureInsight}</div>
                      </div>
                    )}
                    <pre className="text-red-300/80 text-xs font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed">
                      {t.error}
                    </pre>
                    {t.errorObj?.snippet && (
                      <div className="mt-3 pt-3 border-t border-red-500/10">
                        <div className="text-red-400/60 text-xs font-semibold uppercase tracking-wider mb-1">Code Snippet</div>
                        <pre className="text-[#8BA4C8] text-xs font-mono whitespace-pre-wrap leading-relaxed">{t.errorObj.snippet}</pre>
                      </div>
                    )}
                    {Array.isArray(t.errorObj?.callLog) && t.errorObj.callLog.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-red-500/10">
                        <div className="text-red-400/60 text-xs font-semibold uppercase tracking-wider mb-1">Call Log</div>
                        <pre className="text-[#8BA4C8] text-xs font-mono whitespace-pre-wrap leading-relaxed">
                          {t.errorObj.callLog.join('\n')}
                        </pre>
                      </div>
                    )}
                    {t.errorObj?.location && (
                      <div className="mt-2 text-[#4A6280] text-xs font-mono">
                        {t.errorObj.location.file}:{t.errorObj.location.line}:{t.errorObj.location.column}
                      </div>
                    )}
                  </div>
                )}

                {/* Screenshots */}
                {t.screenshots.length > 0 && (
                  <div>
                    <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                      Screenshots ({t.screenshots.length})
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {t.screenshots.map((src, i) => (
                        <ArtifactImage key={i} src={src} alt={`${t.name} screenshot ${i + 1}`} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Videos */}
                {t.videos.length > 0 && (
                  <div>
                    <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                      Videos ({t.videos.length})
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {t.videos.map((src, i) => (
                        <ArtifactVideo key={i} src={src} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Traces */}
                {t.traces.length > 0 && (
                  <div>
                    <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                      Traces ({t.traces.length})
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {t.traces.map((src, i) => (
                        <ArtifactDownload key={i} src={src} label={`Trace ${i + 1}`} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </td>
          </motion.tr>
        )}
      </AnimatePresence>
    </>
  );
}

// ─── Phase display helpers ───────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  started: 'Pipeline Started',
  port_conflict: 'Port Conflict',
  jira: 'Fetching Jira Stories',
  context: 'Gathering Context',
  context_enrichment: 'Enriching Context',
  generating: 'Generating Tests',
  running: 'Running Playwright Tests',
  tests_complete: 'Tests Complete',
  analyzing: 'Analyzing Failures',
  reporting: 'Generating Report',
  uploading_artifacts: 'Uploading Artifacts',
  artifacts_uploaded: 'Artifacts Uploaded',
  artifacts_upload_failed: 'Artifact Upload Failed',
  artifacts_upload_error: 'Artifact Upload Error',
  dashboard: 'Opening Dashboard',
  completed: 'Pipeline Complete',
  error: 'Pipeline Error',
  error_reported: 'Error Reported',
};

const TERMINAL_PHASES = new Set(['completed', 'error', 'error_reported']);

function phaseLabel(phase: string | null): string {
  if (!phase) return 'Unknown';
  return PHASE_LABELS[phase.toLowerCase()] || phase;
}

function PhaseIcon({ phase, isLast }: { phase: string | null; isLast: boolean }) {
  const p = (phase || '').toLowerCase();
  
  // Completed phases - green checkmark
  if (p === 'completed') {
    return (
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
      </span>
    );
  }
  
  // Error/failed phases - red X
  if (p === 'error' || p === 'error_reported' || p === 'artifacts_upload_failed' || p === 'artifacts_upload_error' || p.includes('failed') || p.includes('error')) {
    return (
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#F87171" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </span>
    );
  }
  
  // Currently running phase - blue pulsing dot
  if (isLast) {
    return (
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center">
        <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
      </span>
    );
  }
  
  // Default completed phases - green checkmark
  return (
    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
    </span>
  );
}

function LiveTimeline({ events, liveFiles, pipelineEnded }: {
  events: LiveEvent[];
  liveFiles: string[];
  pipelineEnded: boolean;
}) {
  const displayEvents = events.filter(e =>
    e.eventType !== 'test_results' &&
    e.eventType !== 'test_file_generated' &&
    e.eventType !== 'test_result'
  );
  if (displayEvents.length === 0) return null;
  // Decide which single event owns files to avoid duplicates
  const hasTestsGenEvent = displayEvents.some(e => e.eventType === 'tests_generated');
  return (
    <div className="flex flex-col gap-0">
      {displayEvents.map((ev, i) => {
        const isLast = i === displayEvents.length - 1;
        const isTerminal = TERMINAL_PHASES.has((ev.phase || '').toLowerCase());
        const isTestsGen = ev.eventType === 'tests_generated';
        const isGeneratingPhase = (ev.phase || '').toLowerCase() === 'generating';
        // Show files: prefer tests_generated event if present, else generating phase
        const showFiles = liveFiles.length > 0 && (hasTestsGenEvent ? isTestsGen : isGeneratingPhase);
        const effectiveIsLast = isLast && !isTerminal && !pipelineEnded;
        const time = ev.occurredAt ? new Date(ev.occurredAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : '';
        return (
          <div key={ev.id} className="flex gap-3 group">
            <div className="flex flex-col items-center">
              <PhaseIcon phase={isTerminal ? ev.phase : (effectiveIsLast ? ev.phase : 'done')} isLast={effectiveIsLast} />
              {i < displayEvents.length - 1 && (
                <div className="w-px h-full min-h-[16px] bg-white/10 mt-0.5" />
              )}
            </div>
            <div className="pb-3 flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[#F0F6FF] text-xs font-semibold">{phaseLabel(ev.phase)}</span>
                {time && <span className="text-[#4A6280] text-[10px] font-mono">{time}</span>}
                {ev.durationMs != null && ev.durationMs > 0 && (
                  <span className="text-[#4A6280] text-[10px] font-mono">{(ev.durationMs / 1000).toFixed(1)}s</span>
                )}
              </div>
              {ev.message && (
                <div className="text-[#8BA4C8] text-xs mt-0.5">{ev.message}</div>
              )}
              {ev.reason && (
                <div className="text-red-300/80 text-xs mt-0.5 font-mono">{ev.reason}</div>
              )}

              {/* Live file badges — drip in under generating phase AND tests_generated */}
              {showFiles && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {liveFiles.map((f, fi) => (
                    <motion.span
                      key={f}
                      initial={{ opacity: 0, scale: 0.8, y: 4 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      transition={{ duration: 0.2, delay: fi * 0.055 }}
                      className="px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-300/80 text-[10px] font-mono"
                    >
                      {f}
                    </motion.span>
                  ))}
                </div>
              )}

            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TestRunDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const isLiveDetailId = String(id || '').startsWith('live-');

  const [testRun, setTestRun] = useState<TestRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [activePolling, setActivePolling] = useState(true);
  const lastRunSignatureRef = useRef<string | null>(null);

  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [liveFiles, setLiveFiles] = useState<string[]>([]);
  const [liveTestResults, setLiveTestResults] = useState<LiveTestResult[]>([]);
  const [pipelineOpen, setPipelineOpen] = useState(true);
  const [pipelineEnded, setPipelineEnded] = useState(false);

  const isLiveOrRunning = useCallback((run: TestRun | null) => {
    if (!run) return false;
    if (isLiveDetailId) return true;
    const status = String(run.status || '').toLowerCase();
    const phase = String(run.current_phase || '').toLowerCase();
    if (run.is_live) return true;
    if (status === 'running') return true;
    return [
      'queued',
      'awaiting_configuration',
      'awaiting_config_ui',
      'config_received',
      'starting_pipeline',
      'started',
      'context',
      'context_enrichment',
      'generating',
      'running',
      'reporting',
      'tests_complete',
    ].includes(phase);
  }, [isLiveDetailId]);

  useEffect(() => {
    if (!id || !isLiveDetailId) return;
    const evtSource = new EventSource(`/api/test-runs/${id}/stream`);
    evtSource.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as LiveEvent & { type: string };
        if (data.type === 'event') {
          setLiveEvents(prev => {
            if (prev.some(ev => ev.id === data.id)) return prev;
            return [...prev, data];
          });
          if (data.eventType === 'test_file_generated' && typeof (data.metadata as Record<string, unknown>)?.file === 'string') {
            const file = (data.metadata as Record<string, unknown>).file as string;
            setLiveFiles(prev => prev.includes(file) ? prev : [...prev, file]);
          }
          if (data.eventType === 'test_result' && (data.metadata as Record<string, unknown>)?.test) {
            const t = (data.metadata as Record<string, unknown>).test as LiveTestResult;
            setLiveTestResults(prev => [...prev, t]);
          }
          if (data.eventType === 'test_results' && Array.isArray((data.metadata as Record<string, unknown>)?.tests)) {
            const batch = (data.metadata as Record<string, unknown>).tests as LiveTestResult[];
            setLiveTestResults(prev => prev.length === 0 ? batch : prev);
          }
        } else if (data.type === 'done') {
          evtSource.close();
          setActivePolling(false);
          setPipelineEnded(true);
          // Final fetch to pick up completed state & report
          fetch(`/api/test-runs/${id}`, { cache: 'no-store' })
            .then(res => res.ok ? res.json() : null)
            .then(json => { if (json?.data) setTestRun(json.data); })
            .catch(() => {});
        }
      } catch { /* ignore malformed events */ }
    };
    evtSource.onerror = () => { evtSource.close(); };
    return () => { evtSource.close(); };
  }, [id, isLiveDetailId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!id) return;
    let mounted = true;

    const fetchRun = async (isInitial = false) => {
      if (isInitial) setLoading(true);
      try {
        const res = await fetch(`/api/test-runs/${id}`, { cache: 'no-store' });
        if (!mounted) return;

        if (!res.ok) {
          setNotFound(true);
          setActivePolling(false);
          return;
        }

        const json = await res.json();
        const nextRun = json.data as TestRun;
        const signature = JSON.stringify({
          id: nextRun?.id,
          status: nextRun?.status,
          updated_at: nextRun?.updated_at,
          current_phase: nextRun?.current_phase,
          error_code: nextRun?.error_code,
          total_tests: nextRun?.total_tests,
          passed_tests: nextRun?.passed_tests,
          failed_tests: nextRun?.failed_tests,
          skipped_tests: nextRun?.skipped_tests,
        });

        if (signature !== lastRunSignatureRef.current) {
          lastRunSignatureRef.current = signature;
          setTestRun(nextRun);
        }

        setNotFound(false);
        setActivePolling(isLiveOrRunning(nextRun));
      } catch {
        if (mounted) {
          setNotFound(true);
          setActivePolling(false);
        }
      } finally {
        if (mounted && isInitial) setLoading(false);
      }
    };

    fetchRun(true);
    return () => {
      mounted = false;
    };
  }, [id, isLiveDetailId, isLiveOrRunning]);

  useEffect(() => {
    if (!id || !activePolling) {
      return;
    }

    const intervalMs = 8000;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      fetch(`/api/test-runs/${id}`, { cache: 'no-store' })
        .then((res) => {
          if (!res.ok) return null;
          return res.json();
        })
        .then((json) => {
          if (!json?.data) return;
          const nextRun = json.data as TestRun;
          const signature = JSON.stringify({
            id: nextRun?.id,
            status: nextRun?.status,
            updated_at: nextRun?.updated_at,
            current_phase: nextRun?.current_phase,
            error_code: nextRun?.error_code,
            total_tests: nextRun?.total_tests,
            passed_tests: nextRun?.passed_tests,
            failed_tests: nextRun?.failed_tests,
            skipped_tests: nextRun?.skipped_tests,
          });
          if (signature !== lastRunSignatureRef.current) {
            lastRunSignatureRef.current = signature;
            setTestRun(nextRun);
          }
          setActivePolling(isLiveOrRunning(nextRun));
        })
        .catch(() => {
          // keep existing state, retry on next cycle
        });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [id, activePolling, isLiveDetailId, isLiveOrRunning]);

  // ── Loading ──
  if (loading) {
    return (
      <div className="max-w-6xl mx-auto flex flex-col gap-5">
        <div className="flex items-center gap-3 mb-2">
          <div className="h-8 w-24 bg-white/5 rounded-xl animate-pulse" />
          <div className="h-6 w-48 bg-white/5 rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glass-card rounded-2xl p-5 h-24 animate-pulse bg-white/[0.02]" />
          ))}
        </div>
        <div className="glass-card rounded-2xl h-64 animate-pulse bg-white/[0.02]" />
      </div>
    );
  }

  // ── Not found ──
  if (notFound || !testRun) {
    return (
      <div className="max-w-6xl mx-auto flex flex-col items-center justify-center py-24 gap-6">
        <div className="w-20 h-20 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[#4A6280]">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
        </div>
        <div className="text-center">
          <div className="text-[#F0F6FF] font-bold text-xl mb-2">Test run not found</div>
          <div className="text-[#4A6280] text-sm">This test run may have been deleted or doesn&apos;t exist.</div>
        </div>
        <Link href="/all-tests" className="btn-gradient text-white font-semibold px-6 py-2.5 rounded-xl text-sm">
          Back to All Tests
        </Link>
      </div>
    );
  }

  // ── Parse report ──
  const report: ReportJson | null = testRun.report_json ?? null;
  const liveMeta = report?.metadata?.live || null;
  const liveRunId = report?.metadata?.runId || report?.metadata?.run_id || testRun.run_id || null;
  const rawTests: ReportTest[] = report?.tests ?? report?.results ?? [];
  const normalisedTests = rawTests.map((t, i) => normaliseTest(t, i, id));

  // Filter tests — strip synthetic pipeline rows when we have real test data
  const isPipelineSynthetic = (t: NormalisedTest) =>
    t.suite === 'pipeline' && (t.name.startsWith('[PIPELINE') || t.name.startsWith('[PIPELINE_ERROR'));
  const hasRealTests = liveTestResults.length > 0 || normalisedTests.some(t => !isPipelineSynthetic(t));
  const displayTests = hasRealTests ? normalisedTests.filter(t => !isPipelineSynthetic(t)) : normalisedTests;
  
  // Count of real (non-synthetic) tests for accurate stats
  const realTestsCount = normalisedTests.filter(t => !isPipelineSynthetic(t)).length;

  // Extract generated test count from live events (e.g., "Generated 68 tests across 42 files")
  const generatedTestCount = (() => {
    for (const ev of liveEvents) {
      if (ev.message) {
        const match = ev.message.match(/Generated\s+(\d+)\s+tests/i);
        if (match) return parseInt(match[1], 10);
      }
    }
    return 0;
  })();

  // Use live test results for stats when available (real-time updates)
  const livePassed = liveTestResults.filter(t => t.s === 'passed').length;
  const liveFailed = liveTestResults.filter(t => t.s === 'failed').length;
  const liveSkipped = liveTestResults.filter(t => t.s === 'skipped').length;
  const liveTotal = liveTestResults.length;
  const hasLiveStats = liveTotal > 0;

  // Priority: live results > database stats > generated count > real test count
  const totalTests = hasLiveStats 
    ? liveTotal 
    : (testRun.total_tests || report?.summary?.total || report?.stats?.total || generatedTestCount || realTestsCount);
  const passedTests = hasLiveStats ? livePassed : (testRun.passed_tests || report?.summary?.passed || report?.stats?.passed || displayTests.filter(t => ['passed', 'pass'].includes(t.status.toLowerCase())).length);
  const failedTests = hasLiveStats ? liveFailed : (testRun.failed_tests || report?.summary?.failed || report?.stats?.failed || displayTests.filter(t => ['failed', 'fail'].includes(t.status.toLowerCase())).length);
  const skippedTests = hasLiveStats ? liveSkipped : (testRun.skipped_tests || report?.summary?.skipped || report?.stats?.skipped || displayTests.filter(t => ['skipped', 'skip', 'pending'].includes(t.status.toLowerCase())).length);
  const passRate = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;
  const filteredTests = filterStatus === 'all'
    ? displayTests
    : displayTests.filter(t => {
        const s = t.status.toLowerCase();
        if (filterStatus === 'passed') return s === 'passed' || s === 'pass';
        if (filterStatus === 'failed') return s === 'failed' || s === 'fail';
        if (filterStatus === 'skipped') return s === 'skipped' || s === 'skip' || s === 'pending';
        return true;
      });

  // Count artifacts across all tests
  const totalScreenshots = normalisedTests.reduce((sum, t) => sum + t.screenshots.length, 0);
  const totalVideos = normalisedTests.reduce((sum, t) => sum + t.videos.length, 0);
  const totalTraces = normalisedTests.reduce((sum, t) => sum + t.traces.length, 0);

  // AI analysis
  const aiRaw = testRun.ai_analysis;
  const aiAnalysis: AiAnalysisItem[] = (
    Array.isArray(aiRaw)
      ? aiRaw
      : (Array.isArray(aiRaw?.analyses) ? aiRaw.analyses : Array.isArray(aiRaw?.items) ? aiRaw.items : [])
  ).filter((item: AiAnalysisItem) => (
    !!safeString(item?.testName ?? item?.test ?? item?.test_name)
    || !!safeString(item?.analysis)
    || !!safeString(item?.rootCause ?? item?.root_cause)
    || !!safeString(item?.suggestedFix ?? item?.suggested_fix ?? item?.fix)
  ));

  const formattedDate = new Date(testRun.created_at).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  }) + ' at ' + new Date(testRun.created_at).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-6xl mx-auto flex flex-col gap-6">
      {/* Back + header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-3">
        <Link href="/all-tests" className="inline-flex items-center gap-2 text-[#4A6280] hover:text-[#F0F6FF] text-sm transition-colors w-fit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          Back to All Tests
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-[#F0F6FF] font-bold text-2xl">{testRun.creation_name || 'Test Run'}</h1>
            <p className="text-[#4A6280] text-sm mt-0.5">{formattedDate}</p>
          </div>
          <div className="flex items-center gap-3">
            {testRun.source && (
              <span className="px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-[#60A5FA] text-xs font-semibold uppercase tracking-wider">
                {testRun.source}
              </span>
            )}
            <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
              testRun.status === 'passed' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
              : testRun.status === 'failed' ? 'bg-red-500/10 border border-red-500/20 text-red-400'
              : testRun.status === 'running' ? 'bg-blue-500/10 border border-blue-500/20 text-blue-400'
              : 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
            }`}>
              {testRun.status}
            </span>
          </div>
        </div>
      </motion.div>

      {(testRun.is_live || !!liveMeta || !!testRun.current_phase || !!testRun.error_code || liveEvents.length > 0) && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-card rounded-2xl overflow-hidden border border-blue-500/20 bg-blue-500/[0.03]"
        >
          {/* Header — clickable to collapse/expand */}
          <button
            onClick={() => setPipelineOpen(o => !o)}
            className="w-full px-5 py-3.5 border-b border-white/8 flex items-center justify-between gap-3 text-left hover:bg-white/[0.02] transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
                pipelineEnded
                  ? 'bg-emerald-500/10 border border-emerald-500/30'
                  : 'bg-blue-500/10 border border-blue-500/20'
              }`}>
                {pipelineEnded ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                ) : (
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-pulse" />
                )}
              </div>
              <div>
                <div className="text-[#D8E8FF] font-semibold text-sm">Pipeline Activity</div>
                <div className="text-[#4A6280] text-[11px] font-mono">
                  {pipelineEnded ? 'completed' : (testRun.current_phase || liveMeta?.phase || testRun.status)}
                  {testRun.error_code || liveMeta?.errorCode ? ` · error: ${testRun.error_code || liveMeta?.errorCode}` : ''}
                  {liveRunId ? ` · run: ${liveRunId}` : ''}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {liveEvents.length > 0 && (() => {
                const pipelineCount = liveEvents.filter(e =>
                  e.eventType !== 'test_results' &&
                  e.eventType !== 'test_file_generated' &&
                  e.eventType !== 'test_result'
                ).length;
                return (
                  <div className="flex items-center gap-1.5">
                    <span className="px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[10px] font-semibold">
                      {pipelineCount} step{pipelineCount !== 1 ? 's' : ''}
                    </span>
                    {liveFiles.length > 0 && (
                      <span className="px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-[10px] font-semibold">
                        {liveFiles.length} file{liveFiles.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                );
              })()}
              <svg
                width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className={`text-[#4A6280] transition-transform duration-200 flex-shrink-0 ${pipelineOpen ? 'rotate-180' : ''}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </button>

          <AnimatePresence initial={false}>
            {pipelineOpen && (
              <motion.div
                key="pipeline-body"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25 }}
                style={{ overflow: 'hidden' }}
              >
                {/* SSE timeline */}
                {liveEvents.length > 0 ? (
                  <div className="px-5 py-4">
                    <LiveTimeline events={liveEvents} liveFiles={liveFiles} pipelineEnded={pipelineEnded} />
                  </div>
                ) : (
                  (liveMeta?.message || liveMeta?.reason) && (
                    <div className="px-5 py-3 text-[#BFD4F2] text-xs">
                      {liveMeta?.message || liveMeta?.reason}
                    </div>
                  )
                )}

                {/* Generated Files — standalone section, shown when no tests_generated event */}
                {liveFiles.length > 0 && !liveEvents.some(e => e.eventType === 'tests_generated') && !liveEvents.some(e => (e.phase || '').toLowerCase() === 'generating') && (
                  <div className="border-t border-white/8 px-5 py-3">
                    <div className="text-[#4A6280] text-[10px] font-semibold uppercase tracking-wider mb-2">
                      Generated Files ({liveFiles.length})
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {liveFiles.map((f, fi) => (
                        <motion.span
                          key={f}
                          initial={{ opacity: 0, scale: 0.8, y: 4 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          transition={{ duration: 0.2, delay: fi * 0.055 }}
                          className="px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-300/80 text-[10px] font-mono"
                        >
                          {f}
                        </motion.span>
                      ))}
                    </div>
                  </div>
                )}

                {/* End-of-testing banner */}
                {pipelineEnded && (
                  <div className="border-t border-white/8 px-5 py-3 flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    <span className="text-emerald-400 text-xs font-semibold">Pipeline complete</span>
                    {liveTotal > 0 && (
                      <span className="text-[#4A6280] text-xs">— {livePassed}/{liveTotal} tests passed ({Math.round((livePassed / liveTotal) * 100)}%)</span>
                    )}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
        <KpiCard label="Total Tests" value={totalTests} color="text-[#F0F6FF]" delay={0} />
        <KpiCard label="Passed" value={passedTests} color="text-emerald-400" delay={80} />
        <KpiCard label="Failed" value={failedTests} color="text-red-400" delay={160} />
        <KpiCard label="Skipped" value={skippedTests} color="text-amber-400" delay={240} />
        <KpiCard label="Pass Rate" value={passRate} sub="%" color={passRate >= 80 ? 'text-emerald-400' : 'text-red-400'} delay={320} />
      </div>

      {/* Status distribution bar */}
      {totalTests > 0 && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="glass-card rounded-2xl p-5">
          <h2 className="text-[#F0F6FF] font-semibold text-sm mb-4">Status Distribution</h2>
          <StatusBar passed={passedTests} failed={failedTests} skipped={skippedTests} total={totalTests} />
        </motion.div>
      )}

      {/* Artifacts summary */}
      {(totalScreenshots + totalVideos + totalTraces) > 0 && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.32 }} className="glass-card rounded-2xl p-5">
          <h2 className="text-[#F0F6FF] font-semibold text-sm mb-3">Playwright Artifacts</h2>
          <div className="flex items-center gap-4">
            {totalScreenshots > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-500/5 border border-blue-500/15">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                <span className="text-[#60A5FA] text-sm font-medium">{totalScreenshots} screenshot{totalScreenshots !== 1 ? 's' : ''}</span>
              </div>
            )}
            {totalVideos > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-purple-500/5 border border-purple-500/15">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                <span className="text-[#A78BFA] text-sm font-medium">{totalVideos} video{totalVideos !== 1 ? 's' : ''}</span>
              </div>
            )}
            {totalTraces > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/5 border border-amber-500/15">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                <span className="text-[#FBBF24] text-sm font-medium">{totalTraces} trace{totalTraces !== 1 ? 's' : ''}</span>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* Test results table */}
      {report === null ? (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="glass-card rounded-2xl p-8 flex flex-col items-center justify-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[#4A6280]">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <div className="text-center">
            <div className="text-[#F0F6FF] font-semibold mb-1">Report data not available</div>
            <div className="text-[#4A6280] text-sm">No detailed report was saved for this test run.</div>
          </div>
        </motion.div>
      ) : displayTests.length > 0 ? (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="glass-card rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/8 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-[#F0F6FF] font-semibold text-base">Test Results</h2>
              <p className="text-[#4A6280] text-xs mt-0.5">{totalTests} individual tests — click a row to expand details</p>
            </div>
            {/* Filter buttons */}
            <div className="flex items-center gap-1.5">
              {(['all', 'passed', 'failed', 'skipped'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFilterStatus(f)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                    filterStatus === f
                      ? f === 'passed' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : f === 'failed' ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                        : f === 'skipped' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'bg-white/10 text-[#F0F6FF] border border-white/20'
                      : 'bg-white/5 text-[#4A6280] border border-transparent hover:border-white/10'
                  }`}
                >
                  {f === 'all' ? `All (${displayTests.length})` : f === 'passed' ? `Passed (${passedTests})` : f === 'failed' ? `Failed (${failedTests})` : `Skipped (${skippedTests})`}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left px-6 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Test Name</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Suite / File</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Duration</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Artifacts</th>
                </tr>
              </thead>
              <tbody>
                {filteredTests.map((t, i) => (
                  <TestRow key={i} t={t} idx={i} />
                ))}
              </tbody>
            </table>
          </div>
          {filteredTests.length === 0 && (
            <div className="px-6 py-8 text-center text-[#4A6280] text-sm">No tests match the selected filter.</div>
          )}
        </motion.div>
      ) : null}

      {/* AI Analysis */}
      <AnimatePresence>
        {aiAnalysis.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} className="glass-card rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/8 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2">
                  <path d="M12 2a10 10 0 110 20A10 10 0 0112 2z" /><path d="M12 8v4l3 3" />
                </svg>
              </div>
              <div>
                <h2 className="text-[#F0F6FF] font-semibold text-base">AI Analysis</h2>
                <p className="text-[#4A6280] text-xs">{aiAnalysis.length} issue{aiAnalysis.length !== 1 ? 's' : ''} analysed</p>
              </div>
            </div>
            <div className="p-5 flex flex-col gap-4">
              {aiAnalysis.map((item, i) => {
                const testName = safeString(item.testName ?? item.test ?? item.test_name) ?? `Issue ${i + 1}`;
                const analysis = safeString(item.analysis);
                const rootCause = safeString(item.root_cause ?? item.rootCause);
                const fix = safeString(item.suggested_fix ?? item.suggestedFix ?? item.fix);
                const testingRecommendations = safeString(item.testingRecommendations ?? item.testing_recommendations);
                const confidence = getConfidencePercent(item.confidence);
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.55 + i * 0.08 }}
                    className="rounded-xl bg-purple-500/5 border border-purple-500/10 p-4 flex flex-col gap-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-[#F0F6FF] font-semibold text-sm">{testName}</div>
                      {confidence !== null && (
                        <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-500/10 text-purple-300 border border-purple-500/20 whitespace-nowrap">
                          {`${confidence}% confidence`}
                        </span>
                      )}
                    </div>
                    {analysis && (
                      <div>
                        <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-1">Analysis</div>
                        <div className="text-[#8BA4C8] text-sm">{analysis}</div>
                      </div>
                    )}
                    {rootCause && (
                      <div>
                        <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-1">Root Cause</div>
                        <div className="text-[#8BA4C8] text-sm">{rootCause}</div>
                      </div>
                    )}
                    {fix && (
                      <div>
                        <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-1">Suggested Fix</div>
                        <div className="text-[#8BA4C8] text-sm">{fix}</div>
                      </div>
                    )}
                    {testingRecommendations && (
                      <div>
                        <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-1">Verification</div>
                        <div className="text-[#8BA4C8] text-sm">{testingRecommendations}</div>
                      </div>
                    )}
                    {!analysis && !rootCause && !fix && (
                      <div className="text-[#8BA4C8] text-sm">No structured AI details were provided for this issue.</div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Duration footer */}
      {testRun.duration_ms && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }} className="text-center text-[#4A6280] text-xs pb-4">
          Total run duration: {(testRun.duration_ms / 1000).toFixed(2)}s
        </motion.div>
      )}
    </motion.div>
  );
}
