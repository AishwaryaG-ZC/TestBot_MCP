export default function Footer() {
  const productLinks = [
    { href: '#how-it-works', label: 'How it works' },
    { href: '#features',     label: 'Features' },
    { href: '#integrations', label: 'Integrations' },
    { href: '#dashboard',    label: 'Dashboard' },
    { href: '#pricing',      label: 'Pricing' },
  ];

  const docLinks = [
    { href: '#', label: 'Quick Start' },
    { href: '#', label: 'User Guide' },
    { href: '#', label: 'API Reference' },
    { href: '#', label: 'Playwright Guide' },
  ];

  const resourceLinks = [
    // { href: 'https://github.com/krishsharma1008/TestBot_MCP', label: 'GitHub', external: true },
    { href: 'mailto:zapminds@zapcg.com', label: 'Report a Bug', external: true },
    { href: 'mailto:zapminds@zapcg.com', label: 'Contact' },
  ];

  return (
    <footer className="border-t-2 border-white bg-black">
      <div className="max-w-6xl mx-auto px-6 pt-16 pb-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12">
          {/* Brand */}
          <div className="md:col-span-1">
            <a href="#" className="flex items-center gap-2.5 mb-4 group">
              <div className="w-8 h-8 bg-white border-2 border-black flex items-center justify-center group-hover:bg-black group-hover:border-white transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="stroke-black group-hover:stroke-white transition-colors">
                  <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <span className="text-white font-black text-base font-mono tracking-tight uppercase">
                TestBot_MCP
              </span>
            </a>
            <p className="text-[#505050] text-xs leading-relaxed mb-5 font-mono">
              The AI-native testing agent for modern development teams.
            </p>
            <div className="flex gap-3">
              {/* <a
                href="https://github.com/krishsharma1008/TestBot_MCP"
                target="_blank"
                rel="noopener noreferrer"
                className="w-9 h-9 bg-black border-2 border-[#333] flex items-center justify-center text-[#a0a0a0] hover:text-white hover:border-white transition-all"
                aria-label="GitHub"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
              </a> */}
            </div>
          </div>

          {/* Product links */}
          <div>
            <h5 className="text-white font-black text-xs mb-4 uppercase tracking-widest font-mono">Product</h5>
            <ul className="flex flex-col gap-2.5">
              {productLinks.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className="text-[#505050] hover:text-white text-xs font-mono uppercase tracking-wider transition-colors hover:underline underline-offset-2">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Docs links */}
          <div>
            <h5 className="text-white font-black text-xs mb-4 uppercase tracking-widest font-mono">Docs</h5>
            <ul className="flex flex-col gap-2.5">
              {docLinks.map((link) => (
                <li key={link.label}>
                  <a href={link.href} className="text-[#505050] hover:text-white text-xs font-mono uppercase tracking-wider transition-colors hover:underline underline-offset-2">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Resources links */}
          <div>
            <h5 className="text-white font-black text-xs mb-4 uppercase tracking-widest font-mono">Resources</h5>
            <ul className="flex flex-col gap-2.5">
              {resourceLinks.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    target={link.external ? '_blank' : undefined}
                    rel={link.external ? 'noopener noreferrer' : undefined}
                    className="text-[#505050] hover:text-white text-xs font-mono uppercase tracking-wider transition-colors hover:underline underline-offset-2"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-4 pt-8 border-t-2 border-[#333]">
          <p className="text-[#505050] text-xs font-mono uppercase tracking-widest">
            &copy; 2025 TestBot MCP — Built for AI-native developers
          </p>
          <div className="flex gap-6">
            <a href="#" className="text-[#505050] hover:text-white text-xs font-mono uppercase tracking-widest transition-colors">Privacy</a>
            <a href="#" className="text-[#505050] hover:text-white text-xs font-mono uppercase tracking-widest transition-colors">Terms</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
