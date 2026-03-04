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
  metadata?: { projectPath?: string };
  tests?: ReportTest[];
  results?: ReportTest[];
  summary?: { total?: number; passed?: number; failed?: number; skipped?: number };
  stats?: { total?: number; passed?: number; failed?: number; skipped?: number; duration?: number };
}

interface AiAnalysisItem {
  test?: string;
  test_name?: string;
  root_cause?: string;
  rootCause?: string;
  suggested_fix?: string;
  suggestedFix?: string;
  fix?: string;
  confidence?: number | string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safely convert any error value to a display string */
function errorToString(err: unknown): string | null {
  if (!err) return null;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as ErrorObj;
    return e.message || e.stack || JSON.stringify(err, null, 2);
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

// ─── Count-up animation hook ─────────────────────────────────────────────────

function useCountUp(target: number, duration = 1200, delay = 0) {
  const [value, setValue] = useState(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (target === 0) { setValue(0); return; }
    let start: number | null = null;
    const timeout = setTimeout(() => {
      const step = (ts: number) => {
        if (!start) start = ts;
        const progress = Math.min((ts - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        setValue(Math.round(eased * target));
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
  return (
    <>
      <button onClick={() => setExpanded(true)} className="relative group cursor-pointer rounded-lg overflow-hidden border border-white/10 hover:border-blue-500/40 transition-all">
        <img src={src} alt={alt} className="w-full h-32 object-cover" loading="lazy" />
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
  return (
    <div className="rounded-lg overflow-hidden border border-white/10">
      <video controls preload="metadata" className="w-full max-h-64">
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
                    <pre className="text-red-300/80 text-xs font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed">
                      {t.error}
                    </pre>
                    {t.errorObj?.snippet && (
                      <div className="mt-3 pt-3 border-t border-red-500/10">
                        <div className="text-red-400/60 text-xs font-semibold uppercase tracking-wider mb-1">Code Snippet</div>
                        <pre className="text-[#8BA4C8] text-xs font-mono whitespace-pre-wrap leading-relaxed">{t.errorObj.snippet}</pre>
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

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TestRunDetailPage() {
  const params = useParams();
  const id = params?.id as string;

  const [testRun, setTestRun] = useState<TestRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>('all');

  useEffect(() => {
    if (!id) return;
    async function fetchRun() {
      setLoading(true);
      try {
        const res = await fetch(`/api/test-runs/${id}`);
        if (!res.ok) { setNotFound(true); }
        else {
          const json = await res.json();
          setTestRun(json.data as TestRun);
        }
      } catch { setNotFound(true); }
      finally { setLoading(false); }
    }
    fetchRun();
  }, [id]);

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
  const rawTests: ReportTest[] = report?.tests ?? report?.results ?? [];
  const normalisedTests = rawTests.map((t, i) => normaliseTest(t, i, id));

  const totalTests = testRun.total_tests || report?.summary?.total || report?.stats?.total || normalisedTests.length;
  const passedTests = testRun.passed_tests || report?.summary?.passed || report?.stats?.passed || normalisedTests.filter(t => ['passed', 'pass'].includes(t.status.toLowerCase())).length;
  const failedTests = testRun.failed_tests || report?.summary?.failed || report?.stats?.failed || normalisedTests.filter(t => ['failed', 'fail'].includes(t.status.toLowerCase())).length;
  const skippedTests = testRun.skipped_tests || report?.summary?.skipped || report?.stats?.skipped || normalisedTests.filter(t => ['skipped', 'skip', 'pending'].includes(t.status.toLowerCase())).length;
  const passRate = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;

  // Filter tests
  const filteredTests = filterStatus === 'all'
    ? normalisedTests
    : normalisedTests.filter(t => {
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
  const aiAnalysis: AiAnalysisItem[] = Array.isArray(aiRaw)
    ? aiRaw
    : aiRaw?.analyses ?? aiRaw?.items ?? [];

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
      ) : normalisedTests.length > 0 ? (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="glass-card rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/8 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-[#F0F6FF] font-semibold text-base">Test Results</h2>
              <p className="text-[#4A6280] text-xs mt-0.5">{normalisedTests.length} individual tests — click a row to expand details</p>
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
                  {f === 'all' ? `All (${normalisedTests.length})` : f === 'passed' ? `Passed (${passedTests})` : f === 'failed' ? `Failed (${failedTests})` : `Skipped (${skippedTests})`}
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
                const testName = safeString(item.test ?? item.test_name) ?? `Issue ${i + 1}`;
                const rootCause = safeString(item.root_cause ?? item.rootCause);
                const fix = safeString(item.suggested_fix ?? item.suggestedFix ?? item.fix);
                const confidence = item.confidence ?? null;
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
                          {typeof confidence === 'number' ? `${Math.round(confidence * 100)}% confidence` : confidence}
                        </span>
                      )}
                    </div>
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
