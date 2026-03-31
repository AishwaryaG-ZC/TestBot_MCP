'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface McpSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type IDETab = 'cursor' | 'claude' | 'other';

function getMcpConfig(ide: string) {
  // The dashboard URL will be where the webapp is deployed
  const dashboardUrl = typeof window !== 'undefined' ? window.location.origin : 'https://your-app.vercel.app';
  return `{
  "mcpServers": {
    "testbot-mcp": {
      "command": "npx",
      "args": ["-y", "@testbot/mcp@latest"],
      "env": {
        "TESTBOT_API_KEY": "<your-api-key>",
        "TESTBOT_DASHBOARD_URL": "${dashboardUrl}"
      }
    }
  }
}`;
}

const MAGIC_PROMPT = 'Hey, help me to test this project with TestBot MCP.';

function CopyButton({ text, small = false }: { text: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={`flex items-center gap-1.5 transition-all ${
        small
          ? 'text-xs px-2.5 py-1.5 rounded-lg'
          : 'text-xs px-3 py-2 rounded-lg'
      } ${
        copied
          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
          : 'bg-white/5 text-[#8BA4C8] border border-white/10 hover:text-[#F0F6FF] hover:border-blue-500/30'
      }`}
    >
      {copied ? (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Copied!
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}

export default function McpSetupModal({ isOpen, onClose }: McpSetupModalProps) {
  const [step, setStep] = useState(1);
  const [activeTab, setActiveTab] = useState<IDETab>('cursor');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [keyName, setKeyName] = useState('MCP Setup Key');

  const handleCreateKey = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: keyName.trim() || 'MCP Setup Key' }),
      });
      const json = await res.json();
      if (res.ok && json.data?.key) {
        setApiKey(json.data.key);
      } else {
        console.error('Failed to create API key:', json.error);
      }
    } catch (err) {
      console.error('Failed to create API key:', err);
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    onClose();
    // Reset state after animation
    setTimeout(() => {
      setStep(1);
      setApiKey(null);
      setKeyName('MCP Setup Key');
    }, 300);
  };

  const configWithKey = getMcpConfig(activeTab).replace('<your-api-key>', apiKey ?? '<your-api-key>');

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50"
            onClick={handleClose}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <div className="glass-modal w-full max-w-lg pointer-events-auto max-h-[90vh] overflow-y-auto">
              {/* Header */}
              <div className="flex items-center justify-between p-6 border-b border-white/10">
                <div>
                  <h2 className="text-[#F0F6FF] font-bold text-lg">Quick Install — TestBot MCP</h2>
                  <p className="text-[#4A6280] text-xs mt-0.5">Step {step} of 3</p>
                </div>
                <button
                  onClick={handleClose}
                  className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-[#4A6280] hover:text-[#F0F6FF] hover:border-white/20 transition-all"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {/* Step indicators */}
              <div className="flex gap-2 px-6 py-3 border-b border-white/8">
                {[1, 2, 3].map(s => (
                  <button
                    key={s}
                    onClick={() => s < step && setStep(s)}
                    className="flex items-center gap-2"
                  >
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                      s < step
                        ? 'bg-emerald-500 text-white'
                        : s === step
                          ? 'bg-blue-500 text-white'
                          : 'bg-white/5 text-[#4A6280]'
                    }`}>
                      {s < step ? '✓' : s}
                    </div>
                    {s < 3 && <div className={`w-8 h-px ${s < step ? 'bg-emerald-500/50' : 'bg-white/10'}`} />}
                  </button>
                ))}
              </div>

              {/* Step content */}
              <div className="p-6">
                {step === 1 && (
                  <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }}>
                    <h3 className="text-[#F0F6FF] font-semibold text-base mb-2">Step 1: Create an API Key</h3>
                    <p className="text-[#8BA4C8] text-sm mb-6">
                      Create an API key to connect TestBot to your IDE. Keep this key safe — you won&apos;t see it again.
                    </p>

                    {!apiKey ? (
                      <div className="space-y-4">
                        <div>
                          <label htmlFor="keyName" className="block text-[#8BA4C8] text-xs font-semibold mb-2">
                            Key Name
                          </label>
                          <input
                            id="keyName"
                            type="text"
                            value={keyName}
                            onChange={(e) => setKeyName(e.target.value)}
                            placeholder="e.g., MCP Setup Key"
                            className="input-glass w-full px-4 py-2.5 text-sm"
                          />
                        </div>
                        <button
                          onClick={handleCreateKey}
                          disabled={creating}
                          className="btn-gradient text-black font-semibold px-6 py-3 rounded-xl text-sm disabled:opacity-60 flex items-center gap-2"
                        >
                        {creating ? (
                          <>
                            <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 12a9 9 0 11-6.219-8.56" />
                            </svg>
                            Creating...
                          </>
                        ) : (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                            </svg>
                            Create a Key
                          </>
                        )}
                        </button>
                      </div>
                    ) : (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="space-y-4"
                      >
                        <div className="flex items-center gap-2 p-1.5 pl-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
                          <code className="text-emerald-400 font-mono text-sm flex-1 truncate">{apiKey}</code>
                          <CopyButton text={apiKey} />
                        </div>
                        <p className="text-amber-400 text-xs flex items-start gap-2">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 flex-shrink-0">
                            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                          Copy and save this key now. You won&apos;t be able to see it again.
                        </p>
                        <button
                          onClick={() => setStep(2)}
                          className="btn-gradient font-semibold px-6 py-2.5 rounded-xl text-sm"
                        >
                          Next: Install MCP →
                        </button>
                      </motion.div>
                    )}
                  </motion.div>
                )}

                {step === 2 && (
                  <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }}>
                    <h3 className="text-[#F0F6FF] font-semibold text-base mb-2">Step 2: Install MCP Setting</h3>
                    <p className="text-[#8BA4C8] text-sm mb-5">
                      Add this configuration to your IDE&apos;s MCP settings file.
                    </p>

                    {/* IDE tabs */}
                    <div className="flex gap-1 p-1 bg-white/5 rounded-xl mb-4">
                      {(['cursor', 'claude', 'other'] as IDETab[]).map(tab => (
                        <button
                          key={tab}
                          onClick={() => setActiveTab(tab)}
                          className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all capitalize ${
                            activeTab === tab
                              ? 'bg-blue-500/20 text-[#60A5FA] border border-blue-500/30'
                              : 'text-[#4A6280] hover:text-[#8BA4C8]'
                          }`}
                        >
                          {tab === 'claude' ? 'Claude Code' : tab === 'other' ? 'Other IDEs' : 'Cursor'}
                        </button>
                      ))}
                    </div>

                    {/* Code block */}
                    <div className="relative rounded-xl bg-black/40 border border-white/10 overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-2 border-b border-white/8 bg-white/[0.02]">
                        <span className="text-[#4A6280] text-xs font-mono">mcp.json</span>
                        <CopyButton text={configWithKey} />
                      </div>
                      <pre className="p-4 text-xs overflow-x-auto">
                        {configWithKey.split('\n').map((line, i) => {
                          // Simple syntax highlighting
                          const keyMatch = line.match(/^(\s*)"([^"]+)":/);
                          const strMatch = line.match(/: "([^"]+)"/);
                          if (keyMatch) {
                            return (
                              <div key={i}>
                                <span className="text-[#4A6280]">{line.slice(0, keyMatch[1].length)}</span>
                                <span className="text-[#60A5FA]">&quot;{keyMatch[2]}&quot;</span>
                                <span className="text-[#8BA4C8]">{line.slice(keyMatch[0].length - 1)}</span>
                              </div>
                            );
                          }
                          if (strMatch) {
                            const before = line.slice(0, line.indexOf(': "'));
                            return (
                              <div key={i}>
                                <span className="text-[#8BA4C8]">{before}: </span>
                                <span className="text-emerald-400">&quot;{strMatch[1]}&quot;</span>
                                {line.endsWith(',') ? <span className="text-[#8BA4C8]">,</span> : null}
                              </div>
                            );
                          }
                          return <div key={i} className="text-[#4A6280]">{line}</div>;
                        })}
                      </pre>
                    </div>

                    <div className="mt-4 flex gap-3">
                      <button
                        onClick={() => setStep(1)}
                        className="text-[#4A6280] hover:text-[#8BA4C8] text-sm font-medium px-4 py-2 rounded-xl border border-white/10 hover:border-white/20 transition-all"
                      >
                        ← Back
                      </button>
                      <button
                        onClick={() => setStep(3)}
                        className="btn-gradient font-semibold px-6 py-2.5 rounded-xl text-sm"
                      >
                        Next: Start Testing →
                      </button>
                    </div>
                  </motion.div>
                )}

                {step === 3 && (
                  <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }}>
                    <h3 className="text-[#F0F6FF] font-semibold text-base mb-2">Step 3: Start Testing</h3>
                    <p className="text-[#8BA4C8] text-sm mb-6">
                      Simply type the sentence below in your AI code editor to start testing.
                    </p>

                    <div className="mb-6">
                      <div className="text-[#4A6280] text-xs font-semibold uppercase tracking-wider mb-2">Magic prompt</div>
                      <div className="flex items-center gap-2 p-1.5 pl-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                        <span className="text-[#F0F6FF] text-sm flex-1 italic">&quot;{MAGIC_PROMPT}&quot;</span>
                        <CopyButton text={MAGIC_PROMPT} />
                      </div>
                    </div>

                    <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-4 mb-6">
                      <div className="flex items-start gap-3">
                        <span className="text-xl">🎉</span>
                        <div>
                          <div className="text-emerald-400 font-semibold text-sm mb-1">You&apos;re all set!</div>
                          <p className="text-[#8BA4C8] text-xs leading-relaxed">
                            TestBot MCP will auto-detect your project, generate tests, run them, and open a beautiful results dashboard.
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-3">
                      <button
                        onClick={() => setStep(2)}
                        className="text-[#4A6280] hover:text-[#8BA4C8] text-sm font-medium px-4 py-2 rounded-xl border border-white/10 hover:border-white/20 transition-all"
                      >
                        ← Back
                      </button>
                      <button
                        onClick={handleClose}
                        className="btn-gradient font-semibold px-6 py-2.5 rounded-xl text-sm"
                      >
                        Got it!
                      </button>
                    </div>
                  </motion.div>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
