'use client';

import { useState, useRef, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
const PAGE_TITLES: Record<string, string> = {
  '/home': 'Home',
  '/mcp-tests': 'MCP Tests',
  '/create-tests': 'Create Tests',
  '/all-tests': 'All Tests',
  '/test-lists': 'Test Lists',
  '/monitoring': 'Monitoring',
  '/profile': 'Profile',
  '/plan-billing': 'Plan & Billing',
  '/github-app': 'GitHub App',
  '/api-keys': 'API Keys',
};

interface TopBarProps {
  userEmail?: string;
  userInitials?: string;
}

export default function TopBar({ userEmail = 'user@example.com', userInitials = 'U' }: TopBarProps) {
  const pathname = usePathname();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const pageTitle = PAGE_TITLES[pathname] ?? 'Dashboard';

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <header className="sticky top-0 z-30 h-14 bg-black border-b-2 border-[#333] flex items-center px-6 gap-4">
      {/* Left: page title */}
      <div className="flex-1 min-w-0 pl-10 lg:pl-0">
        <h1 className="text-white font-black text-sm truncate uppercase tracking-widest font-mono">{pageTitle}</h1>
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-3 flex-shrink-0">
        {/* Share Feedback */}
        <a
          href="#"
          target="_blank"
          rel="noopener noreferrer"
          className="hidden sm:flex items-center gap-1.5 text-[#505050] hover:text-white text-xs font-mono font-bold uppercase tracking-widest transition-colors px-3 py-1.5 border border-transparent hover:border-white"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          Feedback
        </a>

        {/* User avatar dropdown */}
        <div ref={dropdownRef} className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 group"
            aria-label="User menu"
          >
            <div className="w-8 h-8 bg-white border-2 border-black flex items-center justify-center text-black text-xs font-black font-mono group-hover:bg-black group-hover:text-white group-hover:border-white transition-colors">
              {userInitials}
            </div>
            <svg
              width="10" height="10"
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`text-[#505050] transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          <AnimatePresence>
            {dropdownOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.1 }}
                className="absolute right-0 top-full mt-2 w-56 glass-modal overflow-hidden"
              >
                {/* User info */}
                <div className="px-4 py-3 border-b-2 border-[#333]">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-white border-2 border-black flex items-center justify-center text-black text-xs font-black font-mono flex-shrink-0">
                      {userInitials}
                    </div>
                    <div className="min-w-0">
                      <div className="text-white text-xs font-black font-mono uppercase truncate">My Account</div>
                      <div className="text-[#505050] text-xs font-mono truncate">{userEmail}</div>
                    </div>
                  </div>
                </div>

                {/* Menu items */}
                <div className="p-1">
                  {[
                    { href: '/profile',      label: 'Profile',       icon: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8' },
                    { href: '/plan-billing', label: 'Plan & Billing', icon: 'M1 4h22v16H1zM1 10h22' },
                    { href: '/api-keys',     label: 'API Keys',       icon: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3' },
                  ].map(item => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setDropdownOpen(false)}
                      className="flex items-center gap-3 px-3 py-2 text-[#a0a0a0] hover:text-white hover:bg-[#1a1a1a] text-xs font-mono uppercase tracking-wider transition-colors"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d={item.icon} />
                      </svg>
                      {item.label}
                    </Link>
                  ))}

                  <div className="border-t-2 border-[#333] my-1" />

                  <button
                    className="flex items-center gap-3 px-3 py-2 text-[#a0a0a0] hover:text-white hover:bg-[#1a1a1a] text-xs font-mono uppercase tracking-wider w-full text-left transition-colors"
                    onClick={async () => {
                      setDropdownOpen(false);
                      await fetch('/api/auth/logout', { method: 'POST' });
                      window.location.href = '/login';
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    Sign Out
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
