'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import McpSetupModal from '@/components/dashboard/McpSetupModal';
import type { TestRun } from '@/lib/types/database';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function PassBadge({ rate }: { rate: number | null }) {
  if (rate === null || rate === undefined) return <span className="text-[#4A6280] text-xs">—</span>;
  const ok = rate >= 80;
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${ok ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
      {rate}% Pass
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = (status ?? '').toLowerCase();
  if (s === 'passed') return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Passed</span>;
  if (s === 'failed') return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20">Failed</span>;
  if (s === 'running') return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse">Running</span>;
  if (s === 'completed_with_findings') return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/25">Findings</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">{status}</span>;
}

const PAGE_SIZE = 25;
const ACTIVE_REFRESH_INTERVAL_MS = 10000;
const IDLE_REFRESH_INTERVAL_MS = 45000;

function hasActivePipelineRuns(runs: TestRun[]): boolean {
  return runs.some((run) => {
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
  });
}

export default function McpTestsPage() {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'date' | 'name'>('date');
  const [page, setPage] = useState(1);
  const [tests, setTests] = useState<TestRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeRunsPresent, setActiveRunsPresent] = useState(false);
  const payloadSignatureRef = useRef<string | null>(null);

  const fetchTests = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const res = await fetch('/api/test-runs?limit=100&sort_by=created_at&order=desc&include_live=true', { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        const allRuns: TestRun[] = json.data ?? [];
        // Filter to MCP source only
        const mcpRuns = allRuns.filter(t => t.source === 'mcp');
        const signature = JSON.stringify(
          mcpRuns.map((item) => [item.id, item.status, item.updated_at, item.current_phase, item.error_code])
        );
        if (signature !== payloadSignatureRef.current) {
          payloadSignatureRef.current = signature;
          setTests(mcpRuns);
        }
        setActiveRunsPresent(hasActivePipelineRuns(mcpRuns));
      }
    } catch {
      // silently fail
    } finally {
      if (isInitial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTests(true);
  }, [fetchTests]);

  useEffect(() => {
    const intervalMs = activeRunsPresent ? ACTIVE_REFRESH_INTERVAL_MS : IDLE_REFRESH_INTERVAL_MS;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      fetchTests(false);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [fetchTests, activeRunsPresent]);

  const filtered = tests
    .filter(t => t.creation_name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sort === 'date'
      ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      : a.creation_name.localeCompare(b.creation_name));

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-5">
      {/* McpServerCard */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass-card rounded-2xl overflow-hidden relative"
      >
        <div className="absolute right-0 top-0 bottom-0 w-48 bg-gradient-to-l from-emerald-500/20 via-emerald-600/10 to-transparent pointer-events-none" />
        <div className="absolute right-6 top-1/2 -translate-y-1/2 opacity-15 pointer-events-none">
          <svg width="100" height="100" viewBox="0 0 100 100" fill="none">
            <rect x="10" y="10" width="80" height="80" rx="12" stroke="#10B981" strokeWidth="2" />
            <rect x="25" y="25" width="50" height="50" rx="8" stroke="#10B981" strokeWidth="1.5" />
            <path d="M35 50l10 10 20-20" stroke="#10B981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="relative p-8">
          <h2 className="text-[#F0F6FF] font-bold text-xl mb-2">Healix MCP Server</h2>
          <p className="text-[#8BA4C8] text-sm mb-5 max-w-lg">
            Connect Healix to your AI code editor via the Model Context Protocol. Generate, run, and analyze tests with a single natural language command.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => setModalOpen(true)}
              className="btn-gradient flex items-center gap-2 text-black font-semibold px-5 py-2.5 rounded-xl text-sm"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
              Quick Install
            </button>
            <a
              href="#"
              className="flex items-center gap-2 text-[#8BA4C8] hover:text-[#F0F6FF] font-semibold px-5 py-2.5 rounded-xl text-sm border border-white/10 hover:border-blue-500/30 transition-all hover:bg-white/5"
            >
              View Docs
            </a>
          </div>
        </div>
      </motion.div>

      {/* Prompt banner */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="flex items-start gap-3 px-5 py-4 rounded-2xl bg-blue-500/10 border border-blue-500/20"
      >
        <span className="text-xl flex-shrink-0">💡</span>
        <p className="text-[#8BA4C8] text-sm leading-relaxed">
          Simply type <span className="text-[#F0F6FF] font-semibold italic">&quot;Hey, test this project with Healix MCP&quot;</span> in your AI code editor and we&apos;ll take care of the rest.
        </p>
      </motion.div>

      {/* Tests Table */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="glass-card rounded-2xl overflow-hidden"
      >
        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-3 p-5 border-b border-white/8">
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4A6280]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="Search tests..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              className="input-glass w-full pl-9 pr-4 py-2.5 text-sm rounded-xl"
            />
          </div>
          <div className="flex gap-2">
            <select
              value={sort}
              onChange={e => setSort(e.target.value as 'date' | 'name')}
              className="input-glass px-3 py-2.5 text-sm rounded-xl text-[#8BA4C8] pr-8 cursor-pointer"
            >
              <option value="date">Sort: Date</option>
              <option value="name">Sort: Name</option>
            </select>
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div className="p-5 flex flex-col gap-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="shimmer h-12 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left px-6 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Name</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Tests</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Backend</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Frontend</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Date</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((test) => (
                  <tr
                    key={test.id}
                    onClick={() => router.push(`/test-run/${test.id}`)}
                    className="border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-all cursor-pointer group"
                  >
                    <td className="px-6 py-4">
                      <Link href={`/test-run/${test.id}`} onClick={e => e.stopPropagation()} className="text-[#F0F6FF] text-sm font-medium group-hover:text-[#60A5FA] transition-colors">
                        {test.creation_name}
                      </Link>
                      {(test.current_phase || test.error_code || test.is_live) && (
                        <div className="text-[11px] text-[#60A5FA] mt-1 font-mono">
                          {test.is_live ? 'live' : 'run'}{test.current_phase ? ` · ${test.current_phase}` : ''}{test.error_code ? ` · ${test.error_code}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-4"><StatusBadge status={test.status} /></td>
                    <td className="px-4 py-4">
                      <span className="text-[#8BA4C8] text-xs font-mono">
                        {test.passed_tests}/{test.total_tests}
                      </span>
                    </td>
                    <td className="px-4 py-4"><PassBadge rate={test.backend_pass_rate} /></td>
                    <td className="px-4 py-4"><PassBadge rate={test.frontend_pass_rate} /></td>
                    <td className="px-4 py-4">
                      <span className="text-[#4A6280] text-xs font-mono">{formatDate(test.created_at)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty state */}
        {!loading && tests.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[#4A6280]">
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
            </div>
            <div className="text-center">
              <div className="text-[#F0F6FF] font-semibold mb-1">No MCP test runs yet</div>
              <div className="text-[#4A6280] text-sm">Set up the MCP server in your IDE to start seeing test results here.</div>
            </div>
            <button onClick={() => setModalOpen(true)} className="btn-gradient text-black font-semibold px-5 py-2.5 rounded-xl text-sm">
              Quick Install
            </button>
          </div>
        )}

        {/* Pagination */}
        {!loading && filtered.length > PAGE_SIZE && (
          <div className="flex items-center justify-between px-5 py-4 border-t border-white/8">
            <div className="flex items-center gap-2 text-[#4A6280] text-xs">
              <span>Row per page:</span>
              <span className="text-[#8BA4C8]">{PAGE_SIZE}</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-[#4A6280] hover:text-[#F0F6FF] hover:bg-white/5 disabled:opacity-30 transition-all"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
              </button>
              {Array.from({ length: Math.max(1, totalPages) }, (_, i) => i + 1).map(n => (
                <button
                  key={n}
                  onClick={() => setPage(n)}
                  className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-medium transition-all ${
                    n === page
                      ? 'bg-blue-500/20 text-[#60A5FA] border border-blue-500/30'
                      : 'text-[#4A6280] hover:text-[#F0F6FF] hover:bg-white/5'
                  }`}
                >
                  {n}
                </button>
              ))}
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-[#4A6280] hover:text-[#F0F6FF] hover:bg-white/5 disabled:opacity-30 transition-all"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg>
              </button>
            </div>
            <div className="text-[#4A6280] text-xs">
              {filtered.length} results
            </div>
          </div>
        )}
      </motion.div>

      <McpSetupModal isOpen={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
