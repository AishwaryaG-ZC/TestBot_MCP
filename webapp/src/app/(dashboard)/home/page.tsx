'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import type { TestRun, ImportSession, Profile } from '@/lib/types/database';
import { toDisplayUnits } from '@/lib/token-units';


function formatDate(iso: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  );
}

function PassBadge({ pass, total, label }: { pass: number; total: number; label: string }) {
  if (total === 0) return <span className="text-[#4A6280] text-xs">—</span>;
  const pct = Math.round((pass / total) * 100);
  const passing = pct >= 80;
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`text-xs font-semibold ${passing ? 'text-emerald-400' : 'text-red-400'}`}>
        {pass}/{total} Pass
      </span>
      <div className="w-16 h-1 bg-white/5 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${passing ? 'bg-emerald-400' : 'bg-red-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[#4A6280] text-[10px]">{label}</span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b border-white/5">
      <td className="px-6 py-4">
        <div className="h-4 w-48 bg-white/5 rounded animate-pulse" />
      </td>
      <td className="px-4 py-4">
        <div className="h-4 w-20 bg-white/5 rounded animate-pulse" />
      </td>
      <td className="px-4 py-4">
        <div className="h-4 w-20 bg-white/5 rounded animate-pulse" />
      </td>
      <td className="px-4 py-4">
        <div className="h-4 w-28 bg-white/5 rounded animate-pulse" />
      </td>
    </tr>
  );
}

function SkeletonListItem() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-8 h-8 rounded-lg bg-white/5 animate-pulse flex-shrink-0" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3.5 w-32 bg-white/5 rounded animate-pulse" />
        <div className="h-3 w-16 bg-white/5 rounded animate-pulse" />
      </div>
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [recentTests, setRecentTests] = useState<TestRun[]>([]);
  const [imports, setImports] = useState<ImportSession[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        const [runsRes, importsRes, profileRes] = await Promise.all([
          fetch('/api/test-runs?limit=5&sort_by=created_at&order=desc'),
          fetch('/api/import-tests'),
          fetch('/api/profile'),
        ]);

        const runsJson = await runsRes.json();
        const importsJson = await importsRes.json();
        const profileJson = await profileRes.json();

        const runs: TestRun[] = runsJson.data ?? [];
        const importsList: ImportSession[] = importsJson.data ?? [];

        setRecentTests(runs);
        setImports(importsList.slice(0, 5));
        setProfile(profileJson.data ?? null);
      } catch (err) {
        console.error('Failed to fetch home data:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  // Plan card reads the SAME token fields the sidebar does — both surfaces
  // derive from profile.tokens_remaining / tokens_total through toDisplayUnits.
  // No `credits_*` fallbacks: that legacy column is never decremented by the
  // runtime, so rendering it would drift from actual billing.
  const tokensRemaining = toDisplayUnits(profile?.tokens_remaining);
  const tokensTotal = toDisplayUnits(profile?.tokens_total);
  const tokensRemainingPct = tokensTotal > 0 ? Math.min(100, (tokensRemaining / tokensTotal) * 100) : 0;
  const plan = profile?.plan ?? 'free';

  // Determine the next upgrade target so the CTA always reflects reality.
  const nextPlan: { id: string; label: string; description: string } | null =
    plan === 'free'
      ? { id: 'starter', label: 'Starter', description: 'Get 2,500 credits/mo + advanced AI models + Jira integration.' }
      : plan === 'starter'
      ? { id: 'team', label: 'Team', description: 'Get 10,000 credits/mo + CI/CD integration + priority support.' }
      : null // team / enterprise — already on top plan

  const containerVariants = {
    hidden: {},
    show: { transition: { staggerChildren: 0.08 } },
  };
  const itemVariants = {
    hidden: { opacity: 0, y: 16 },
    show: { opacity: 1, y: 0, transition: { duration: 0.45 } },
  };

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="show"
      className="max-w-7xl mx-auto flex flex-col gap-5"
    >
      {/* Get Started Card — full width */}
      <motion.div variants={itemVariants} className="glass-card rounded-2xl overflow-hidden relative">
        {/* Green gradient banner on right */}
        <div className="absolute right-0 top-0 bottom-0 w-64 bg-gradient-to-l from-emerald-500/20 via-emerald-600/10 to-transparent pointer-events-none" />
        <div className="absolute right-6 top-1/2 -translate-y-1/2 opacity-20 pointer-events-none">
          <svg width="120" height="120" viewBox="0 0 120 120" fill="none">
            <circle cx="60" cy="60" r="50" stroke="#10B981" strokeWidth="2" strokeDasharray="8 4" />
            <circle cx="60" cy="60" r="30" stroke="#10B981" strokeWidth="1.5" />
            <path d="M40 60l13 13 27-27" stroke="#10B981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <div className="relative p-8">
          <h2 className="text-[#F0F6FF] font-bold text-2xl mb-2">Get Started with Healix MCP</h2>
          <p className="text-[#8BA4C8] text-sm mb-6 max-w-lg">
            Start your automated testing for free. Connect your IDE and generate comprehensive tests with a single command.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/mcp-tests"
              className="btn-gradient flex items-center gap-2 text-black font-semibold px-5 py-2.5 rounded-xl text-sm"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" />
                <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
              </svg>
              Test Locally (MCP)
            </Link>
            {/* <button className="flex items-center gap-2 text-[#8BA4C8] hover:text-[#F0F6FF] font-semibold px-5 py-2.5 rounded-xl text-sm border border-white/10 hover:border-blue-500/30 transition-all hover:bg-white/5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" /><polygon points="10 8 16 12 10 16 10 8" />
              </svg>
              Test Deployed App
            </button> */}
            {/* <a
              href="#"
              className="flex items-center gap-2 text-[#8BA4C8] hover:text-[#F0F6FF] font-semibold px-5 py-2.5 rounded-xl text-sm border border-white/10 hover:border-blue-500/30 transition-all hover:bg-white/5"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
              </svg>
              View Docs
            </a> */}
          </div>
        </div>
      </motion.div>

      {/* Two-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Recent Tests Table — left, 2 cols */}
        <motion.div variants={itemVariants} className="lg:col-span-2 glass-card rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/8">
            <h3 className="text-[#F0F6FF] font-semibold text-base">Recent Created Tests</h3>
            <div className="flex items-center gap-3">
              <Link href="/all-tests" className="text-[#60A5FA] text-xs hover:text-[#93C5FD] transition-colors font-medium">
                View All →
              </Link>
              <Link
                href="/create-tests"
                className="w-6 h-6 rounded-md bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-[#60A5FA] hover:bg-blue-500/30 transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </Link>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left px-6 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider"> Name</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Passed</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Created</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <>
                    <SkeletonRow />
                    <SkeletonRow />
                    <SkeletonRow />
                    <SkeletonRow />
                  </>
                ) : (
                  recentTests.map((test, i) => {
                    const passRate = test.total_tests > 0
                      ? Math.round((test.passed_tests / test.total_tests) * 100)
                      : null;
                    return (
                      <motion.tr
                        key={test.id}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: i * 0.06 }}
                        onClick={() => router.push(`/test-run/${test.id}`)}
                        className="border-b border-white/5 last:border-0 hover:bg-white/[0.02] hover:shadow-[inset_0_0_20px_rgba(59,130,246,0.05)] transition-all cursor-pointer group"
                      >
                        <td className="px-6 py-4">
                          <Link
                            href={`/test-run/${test.id}`}
                            className="text-[#F0F6FF] text-sm font-medium group-hover:text-[#60A5FA] transition-colors"
                          >
                            {test.creation_name}
                          </Link>
                        </td>
                        <td className="px-4 py-4">
                          {test.total_tests > 0 ? (
                            <PassBadge
                              pass={test.passed_tests}
                              total={test.total_tests}
                              label={`${passRate}%`}
                            />
                          ) : (
                            <span className="text-[#4A6280] text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-4">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                            test.status === 'passed'
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : test.status === 'failed'
                              ? 'bg-red-500/10 text-red-400'
                              : test.status === 'running'
                              ? 'bg-blue-500/10 text-blue-400'
                              : test.status === 'completed_with_findings'
                              ? 'bg-amber-500/10 text-amber-300'
                              : 'bg-amber-500/10 text-amber-400'
                          }`}>
                            {test.status === 'completed_with_findings' ? 'findings' : test.status}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          <span className="text-[#4A6280] text-xs font-mono whitespace-nowrap">{formatDate(test.created_at)}</span>
                        </td>
                      </motion.tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </motion.div>

        {/* Right column: Test Lists + Plan Card */}
        <div className="flex flex-col gap-5">
          {/* Import Tests Panel */}
          <motion.div variants={itemVariants} className="glass-card rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
              <h3 className="text-[#F0F6FF] font-semibold text-sm">My Imports</h3>
              <div className="flex items-center gap-2">
                <Link href="/import-tests" className="text-[#60A5FA] text-xs hover:text-[#93C5FD] transition-colors font-medium">
                  View All →
                </Link>
                <Link
                  href="/import-tests"
                  className="w-6 h-6 rounded-md bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-[#60A5FA] hover:bg-blue-500/30 transition-colors"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </Link>
              </div>
            </div>

            <div className="p-3 flex flex-col gap-1">
              {loading ? (
                <>
                  <SkeletonListItem />
                  <SkeletonListItem />
                  <SkeletonListItem />
                </>
              ) : (
                imports.map((imp) => (
                  <Link
                    key={imp.id}
                    href={`/import-tests/${imp.id}`}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors group"
                  >
                    <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[#F0F6FF] text-sm font-medium truncate group-hover:text-[#60A5FA] transition-colors">{imp.name}</div>
                      <div className="text-[#4A6280] text-xs">{imp.test_case_count} test cases · {imp.status}</div>
                    </div>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[#4A6280] group-hover:text-[#8BA4C8] transition-colors">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </Link>
                ))
              )}

              <Link
                href="/import-tests"
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-[#60A5FA] hover:bg-blue-500/10 transition-colors text-sm font-medium mt-1"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Import Excel
              </Link>
            </div>
          </motion.div>

          {/* Plan Card */}
          <motion.div variants={itemVariants} className="glass-card rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
              <h3 className="text-[#F0F6FF] font-semibold text-sm">My Plan</h3>
              <Link
                href="/plan-billing"
                className="text-[#60A5FA] text-xs hover:text-[#93C5FD] transition-colors font-medium"
              >
                Manage Plan →
              </Link>
            </div>

            <div className="p-5">
              {loading ? (
                <div className="space-y-3">
                  <div className="h-6 w-20 bg-white/5 rounded-full animate-pulse" />
                  <div className="h-2 w-full bg-white/5 rounded-full animate-pulse" />
                  <div className="h-10 w-full bg-white/5 rounded-xl animate-pulse mt-4" />
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <span className="px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-[#60A5FA] text-sm font-bold capitalize">
                      {plan}
                    </span>
                    <span className="text-[#4A6280] text-xs">{tokensRemaining.toLocaleString()} tokens left</span>
                  </div>

                  <div className="mb-2">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[#8BA4C8] text-xs">Credits remaining</span>
                      <span className="text-[#F0F6FF] text-xs font-semibold">{tokensRemaining.toLocaleString()}/{tokensTotal.toLocaleString()}</span>
                    </div>
                    <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${tokensRemainingPct.toFixed(1)}%` }}
                        transition={{ duration: 1, delay: 0.5 }}
                        className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-500"
                      />
                    </div>
                  </div>

                  {nextPlan ? (
                    <>
                      <p className="text-[#4A6280] text-xs mt-3">
                        {nextPlan.description}
                      </p>
                      <Link
                        href="/plan-billing"
                        className="mt-4 block w-full py-2.5 rounded-xl btn-gradient text-black font-semibold text-sm text-center"
                      >
                        Upgrade to {nextPlan.label}
                      </Link>
                    </>
                  ) : (
                    <Link
                      href="/plan-billing"
                      className="mt-4 block w-full py-2.5 rounded-xl border border-white/10 text-[#8BA4C8] font-semibold text-sm text-center hover:bg-white/5 transition-colors"
                    >
                      Manage Plan →
                    </Link>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
