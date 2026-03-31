'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import type { TestRun } from '@/lib/types/database';

const PAGE_SIZE_OPTIONS = [10, 25, 50];
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

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  );
}

function StatusCell({ pass, total }: { pass: number; total: number }) {
  if (total === 0) return <span className="text-[#4A6280] text-xs">N/A</span>;
  const pct = Math.round((pass / total) * 100);
  const ok = pct >= 80;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
          {pass}/{total}
        </span>
      </div>
      <div className="w-20 h-1 bg-white/5 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${ok ? 'bg-emerald-400' : 'bg-red-400'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b border-white/5">
      <td className="px-6 py-4"><div className="h-4 w-52 bg-white/5 rounded animate-pulse" /></td>
      <td className="px-4 py-4"><div className="h-4 w-20 bg-white/5 rounded animate-pulse" /></td>
      <td className="px-4 py-4"><div className="h-5 w-16 bg-white/5 rounded-full animate-pulse" /></td>
      <td className="px-4 py-4"><div className="h-4 w-32 bg-white/5 rounded animate-pulse" /></td>
    </tr>
  );
}

export default function AllTestsPage() {
  const [tests, setTests] = useState<TestRun[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [activeRunsPresent, setActiveRunsPresent] = useState(false);
  const payloadSignatureRef = useRef<string | null>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'passed' | 'failed' | 'running'>('all');
  const [sortBy, setSortBy] = useState<'date' | 'name' | 'status'>('date');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const fetchTests = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading === true;
    if (showLoading) setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(pageSize),
        sort_by: sortBy === 'date' ? 'created_at' : sortBy === 'name' ? 'created_at' : 'status',
        order: 'desc',
      });

      if (statusFilter !== 'all') {
        params.set('status', statusFilter);
      }

      const res = await fetch(`/api/test-runs?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const json = await res.json();

      let data: TestRun[] = json.data ?? [];

      // Client-side filter by search (creation_name) — API may not support it
      if (debouncedSearch.trim()) {
        const q = debouncedSearch.toLowerCase();
        data = data.filter((t) => t.creation_name?.toLowerCase().includes(q));
      }

      // Client-side sort by name if selected (API sorts by field name)
      if (sortBy === 'name') {
        data = [...data].sort((a, b) =>
          (a.creation_name ?? '').localeCompare(b.creation_name ?? '')
        );
      }

      const pag = json.pagination;
      const nextTotal = pag ? (pag.total ?? data.length) : data.length;
      const nextTotalPages = pag ? (pag.totalPages ?? 1) : 1;
      const nextActive = hasActivePipelineRuns(data);

      const signature = JSON.stringify({
        ids: data.map((item) => [item.id, item.status, item.updated_at, item.current_phase, item.error_code]),
        total: nextTotal,
        totalPages: nextTotalPages,
      });

      if (signature !== payloadSignatureRef.current) {
        payloadSignatureRef.current = signature;
        setTests(data);
        setTotal(nextTotal);
        setTotalPages(nextTotalPages);
      }
      setActiveRunsPresent(nextActive);
    } catch (err) {
      console.error('Failed to fetch test runs:', err);
      if (showLoading) {
        setTests([]);
        setTotal(0);
        setTotalPages(1);
      }
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [page, pageSize, sortBy, statusFilter, debouncedSearch]);

  useEffect(() => {
    fetchTests({ showLoading: true });
  }, [fetchTests]);

  useEffect(() => {
    const intervalMs = activeRunsPresent ? ACTIVE_REFRESH_INTERVAL_MS : IDLE_REFRESH_INTERVAL_MS;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      fetchTests({ showLoading: false });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [fetchTests, activeRunsPresent]);

  // Reset page when filters change
  const handleStatusChange = (v: typeof statusFilter) => {
    setStatusFilter(v);
    setPage(1);
  };
  const handleSortChange = (v: typeof sortBy) => {
    setSortBy(v);
    setPage(1);
  };
  const handlePageSizeChange = (v: number) => {
    setPageSize(v);
    setPage(1);
  };

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-5">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <h2 className="text-[#F0F6FF] font-bold text-xl">All Tests</h2>
          <p className="text-[#4A6280] text-sm mt-0.5">
            {loading ? 'Loading...' : `${total} test run${total !== 1 ? 's' : ''} total`}
          </p>
        </div>
        <Link
          href="/create-tests"
          className="btn-gradient flex items-center gap-2 text-black font-semibold px-4 py-2.5 rounded-xl text-sm"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Tests
        </Link>
      </motion.div>

      {/* Table */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="glass-card rounded-2xl overflow-hidden">
        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-3 p-5 border-b border-white/8">
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4A6280]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="Search by name..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="input-glass w-full pl-9 pr-4 py-2.5 text-sm rounded-xl"
            />
          </div>
          <div className="flex gap-2">
            <select
              value={statusFilter}
              onChange={e => handleStatusChange(e.target.value as typeof statusFilter)}
              className="input-glass px-3 py-2.5 text-sm rounded-xl text-[#8BA4C8] cursor-pointer"
            >
              <option value="all">All Status</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="running">Running</option>
            </select>
            <select
              value={sortBy}
              onChange={e => handleSortChange(e.target.value as typeof sortBy)}
              className="input-glass px-3 py-2.5 text-sm rounded-xl text-[#8BA4C8] cursor-pointer"
            >
              <option value="date">Sort: Date</option>
              <option value="name">Sort: Name</option>
              <option value="status">Sort: Status</option>
            </select>
          </div>
        </div>

        {/* Table body */}
        <div className="overflow-x-auto">
          {loading ? (
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left px-6 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Name</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Tests Passed</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Created</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)}
              </tbody>
            </table>
          ) : tests.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[#4A6280]">
                  <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                </svg>
              </div>
              <div className="text-center">
                {debouncedSearch || statusFilter !== 'all' ? (
                  <>
                    <div className="text-[#F0F6FF] font-semibold mb-1">No tests found</div>
                    <div className="text-[#4A6280] text-sm">Try adjusting your search or filters</div>
                  </>
                ) : (
                  <>
                    <div className="text-[#F0F6FF] font-semibold mb-1">No tests yet</div>
                    <div className="text-[#4A6280] text-sm">Run your first test to see results here</div>
                  </>
                )}
              </div>
              {!debouncedSearch && statusFilter === 'all' && (
                <Link href="/create-tests" className="btn-gradient text-white font-semibold px-5 py-2.5 rounded-xl text-sm">
                  Create Your First Test
                </Link>
              )}
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left px-6 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Name</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Tests Passed</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Created</th>
                </tr>
              </thead>
              <AnimatePresence mode="wait">
                <motion.tbody
                  key={`${page}-${statusFilter}-${sortBy}-${debouncedSearch}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {tests.map((test) => (
                    <tr
                      key={test.id}
                      className="border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-all cursor-pointer group"
                    >
                      <td className="px-6 py-4">
                        <Link
                          href={`/test-run/${test.id}`}
                          className="text-[#F0F6FF] text-sm font-medium group-hover:text-[#60A5FA] transition-colors"
                        >
                          {test.creation_name || 'Untitled Test'}
                        </Link>
                        {(test.current_phase || test.error_code || test.is_live) && (
                          <div className="text-[11px] text-[#60A5FA] mt-1 font-mono">
                            {test.is_live ? 'live' : 'run'}{test.current_phase ? ` · ${test.current_phase}` : ''}{test.error_code ? ` · ${test.error_code}` : ''}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <StatusCell pass={test.passed_tests} total={test.total_tests} />
                      </td>
                      <td className="px-4 py-4">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                          test.status === 'passed'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : test.status === 'failed'
                            ? 'bg-red-500/10 text-red-400'
                            : test.status === 'running'
                            ? 'bg-blue-500/10 text-blue-400'
                            : 'bg-amber-500/10 text-amber-400'
                        }`}>
                          {test.status}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <span className="text-[#4A6280] text-xs font-mono whitespace-nowrap">{formatDateTime(test.created_at)}</span>
                      </td>
                    </tr>
                  ))}
                </motion.tbody>
              </AnimatePresence>
            </table>
          )}
        </div>

        {/* Pagination */}
        {!loading && tests.length > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-4 border-t border-white/8">
            <div className="flex items-center gap-2 text-[#4A6280] text-xs">
              <span>Rows per page:</span>
              <select
                value={pageSize}
                onChange={e => handlePageSizeChange(Number(e.target.value))}
                className="bg-transparent border border-white/10 rounded-lg px-2 py-1 text-[#8BA4C8] text-xs cursor-pointer"
              >
                {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(1)} disabled={page === 1} className="w-8 h-8 rounded-lg flex items-center justify-center text-[#4A6280] hover:text-[#F0F6FF] hover:bg-white/5 disabled:opacity-30 transition-all text-xs">«</button>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="w-8 h-8 rounded-lg flex items-center justify-center text-[#4A6280] hover:text-[#F0F6FF] hover:bg-white/5 disabled:opacity-30 transition-all">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
              </button>
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                // Show pages around current page
                let start = Math.max(1, page - 2);
                const end = Math.min(totalPages, start + 4);
                start = Math.max(1, end - 4);
                return start + i;
              }).filter(n => n <= totalPages).map(n => (
                <button key={n} onClick={() => setPage(n)} className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-medium transition-all ${n === page ? 'bg-blue-500/20 text-[#60A5FA] border border-blue-500/30' : 'text-[#4A6280] hover:text-[#F0F6FF] hover:bg-white/5'}`}>{n}</button>
              ))}
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="w-8 h-8 rounded-lg flex items-center justify-center text-[#4A6280] hover:text-[#F0F6FF] hover:bg-white/5 disabled:opacity-30 transition-all">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg>
              </button>
              <button onClick={() => setPage(totalPages)} disabled={page >= totalPages} className="w-8 h-8 rounded-lg flex items-center justify-center text-[#4A6280] hover:text-[#F0F6FF] hover:bg-white/5 disabled:opacity-30 transition-all text-xs">»</button>
            </div>
            <div className="text-[#4A6280] text-xs">
              {total} results · page {page} of {totalPages}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
