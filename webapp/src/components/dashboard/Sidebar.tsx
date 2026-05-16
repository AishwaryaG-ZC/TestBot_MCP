'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { toDisplayUnits } from '@/lib/token-units';

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'OVERVIEW',
    items: [
      {
        href: '/home',
        label: 'Home',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        ),
      },
      // {
      //   href: '/mcp-tests',
      //   label: 'MCP Tests',
      //   icon: (
      //     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      //       <rect x="2" y="2" width="20" height="8" rx="0" ry="0" />
      //       <rect x="2" y="14" width="20" height="8" rx="0" ry="0" />
      //       <line x1="6" y1="6" x2="6.01" y2="6" />
      //       <line x1="6" y1="18" x2="6.01" y2="18" />
      //     </svg>
      //   ),
      // },
    ],
  },
  {
    label: 'TESTING',
    items: [
      {
        href: '/create-tests',
        label: 'Create Tests',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="0" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
        ),
      },
      {
        href: '/all-tests',
        label: 'All Tests',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        ),
      },
      {
        href: '/import-tests',
        label: 'Import Tests',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        ),
      },
      {
        href: '/workspace',
        label: 'Workspace',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 00-3-3.87" />
            <path d="M16 3.13a4 4 0 010 7.75" />
          </svg>
        ),
      },
      // {
      //   href: '/monitoring',
      //   label: 'Monitoring',
      //   icon: (
      //     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      //       <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      //     </svg>
      //   ),
      // },
    ],
  },
  {
    label: 'SETTINGS',
    items: [
      {
        href: '/profile',
        label: 'Profile',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        ),
      },
      {
        href: '/plan-billing',
        label: 'Usage & Billing',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="4" width="22" height="16" rx="0" ry="0" />
            <line x1="1" y1="10" x2="23" y2="10" />
          </svg>
        ),
      },
      // {
      //   href: '/github-app',
      //   label: 'GitHub App',
      //   icon: (
      //     <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      //       <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
      //     </svg>
      //   ),
      // },
      {
        href: '/api-keys',
        label: 'API Keys',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
          </svg>
        ),
      },
      // WS-4: dedicated Claude-local setup page (`/settings/claude-local`).
      // Lives in the Settings section so users can find it from any dashboard
      // route, not just by direct URL.
      {
        href: '/settings/claude-local',
        label: 'Claude Local',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        ),
      },
    ],
  },
];

interface SidebarProps {
  tokensRemaining?: number;
  tokensTotal?: number;
  plan?: string;
}

export default function Sidebar({ tokensRemaining: initialRemaining = 0, tokensTotal: initialTotal = 0, plan: initialPlan = 'free' }: SidebarProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [tokensRemaining, setTokensRemaining] = useState(initialRemaining);
  const [tokensTotal, setTokensTotal] = useState(initialTotal);
  const [plan, setPlan] = useState(initialPlan);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/profile');
      if (!res.ok) return;
      const { data } = await res.json();
      if (data) {
        setTokensRemaining(toDisplayUnits(data.tokens_remaining));
        setTokensTotal(toDisplayUnits(data.tokens_total));
        setPlan(data.plan ?? 'free');
      }
    } catch { }
  }, []);

  useEffect(() => {
    fetchProfile();
    window.addEventListener('focus', fetchProfile);
    window.addEventListener('healix:profile-updated', fetchProfile);
    return () => {
      window.removeEventListener('focus', fetchProfile);
      window.removeEventListener('healix:profile-updated', fetchProfile);
    };
  }, [fetchProfile]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="px-5 py-5 border-b-2 border-[#333]">
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="w-7 h-7 bg-white border-2 border-black flex items-center justify-center flex-shrink-0 group-hover:bg-black group-hover:border-white transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="stroke-black group-hover:stroke-white transition-colors">
              <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <span className="text-white font-black text-sm font-mono tracking-tight uppercase">
            HEALIX_MCP
          </span>
        </Link>
      </div>

      {/* Nav sections */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-5">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            <div className="px-2 mb-2 flex items-center gap-2">
              <div className="h-px flex-1 bg-[#222]" />
              <span className="text-[9px] font-black tracking-widest text-[#505050] uppercase font-mono">
                {section.label}
              </span>
              <div className="h-px flex-1 bg-[#222]" />
            </div>
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <li key={item.href} className="relative">
                    {active && (
                      <motion.div
                        layoutId="sidebar-active"
                        className="absolute inset-0 bg-white"
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      />
                    )}
                    <Link
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      className={`relative flex items-center gap-3 px-3 py-2 text-xs font-bold font-mono uppercase tracking-wider transition-colors duration-100 ${
                        active
                          ? 'text-black'
                          : 'text-[#505050] hover:text-white hover:bg-[#1a1a1a]'
                      }`}
                    >
                      <span>{item.icon}</span>
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Credits / Plan footer */}
      <div className="px-3 py-4 border-t-2 border-[#333]">
        <div className="bg-[#0a0a0a] border-2 border-[#333] p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[#a0a0a0] text-xs font-mono uppercase tracking-wider">Credits</span>
            <span className="y2k-badge">{plan === 'free' ? 'trial' : plan}</span>
          </div>
          <div className={`font-black text-lg font-mono mb-2 ${tokensRemaining === 0 ? 'text-red-400' : 'text-white'}`}>{tokensRemaining}</div>
          <div className="h-1.5 bg-[#222] overflow-hidden mb-3 border border-[#333]">
            <div
              className={`h-full transition-all duration-1000 ${tokensRemaining === 0 ? 'bg-red-500' : 'bg-white'}`}
              style={{ width: `${tokensTotal > 0 ? (tokensRemaining / tokensTotal) * 100 : 0}%` }}
            />
          </div>
          {tokensRemaining === 0 && (
            <div className="text-[10px] text-red-400 font-mono mb-2 uppercase tracking-wider">
              ⚠ Out of credits
            </div>
          )}
          <Link
            href="/plan-billing"
            className={`block text-center text-xs font-mono font-bold uppercase tracking-widest transition-colors ${tokensRemaining === 0 ? 'text-red-400 hover:text-red-300' : 'text-white hover:text-[#a0a0a0]'}`}
          >
            {tokensRemaining === 0 ? 'Upgrade Plan →' : 'Manage Plan →'}
          </Link>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="glass-sidebar hidden lg:flex flex-col fixed left-0 top-0 bottom-0 w-[260px] z-40">
        <SidebarContent />
      </aside>

      {/* Mobile toggle button */}
      <button
        className="lg:hidden fixed top-4 left-4 z-50 w-10 h-10 bg-black border-2 border-white flex items-center justify-center text-white shadow-[2px_2px_0px_#555]"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label="Toggle sidebar"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* Mobile sidebar overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="lg:hidden fixed inset-0 bg-black/80 z-40"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              className="glass-sidebar lg:hidden fixed left-0 top-0 bottom-0 w-[260px] z-50 flex flex-col"
            >
              <SidebarContent />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
