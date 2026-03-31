'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  is_active: boolean;
}

function formatDate(iso: string | null) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface CopiedState {
  [id: string]: boolean;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copiedStates, setCopiedStates] = useState<CopiedState>({});
  const [revokeConfirm, setRevokeConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch keys on mount
  useEffect(() => {
    fetchKeys();
  }, []);

  const fetchKeys = async () => {
    try {
      const res = await fetch('/api/api-keys');
      const json = await res.json();
      if (res.ok) {
        setKeys(json.data || []);
      }
    } catch {
      // silently fail, show empty
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreating(true);
    setError(null);

    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newKeyName.trim() }),
      });
      const json = await res.json();

      if (!res.ok) {
        setError(json.error || 'Failed to create key');
        setCreating(false);
        return;
      }

      // Show the full key once
      setGeneratedKey(json.data.key);
      // Refresh the list
      await fetchKeys();
      setNewKeyName('');
    } catch {
      setError('Network error');
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedStates(prev => ({ ...prev, [id]: true }));
    setTimeout(() => setCopiedStates(prev => ({ ...prev, [id]: false })), 2000);
  };

  const handleRevoke = async (id: string) => {
    try {
      const res = await fetch(`/api/api-keys/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setKeys(prev => prev.filter(k => k.id !== id));
      }
    } catch {
      // silently fail
    }
    setRevokeConfirm(null);
  };

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-5">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <h2 className="text-[#F0F6FF] font-bold text-xl">API Keys</h2>
          <p className="text-[#4A6280] text-sm mt-0.5">Manage API keys for connecting TestBot to your IDE</p>
        </div>
        <button
          onClick={() => { setShowCreateForm(true); setGeneratedKey(null); setError(null); }}
          className="btn-gradient flex items-center gap-2 font-semibold px-4 py-2.5 rounded-xl text-sm"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Create New Key
        </button>
      </motion.div>

      {/* Create form */}
      <AnimatePresence>
        {showCreateForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="glass-card rounded-2xl p-6 border-blue-500/30">
              <h3 className="text-[#F0F6FF] font-semibold text-base mb-4">
                {generatedKey ? 'New API Key Created' : 'Create API Key'}
              </h3>

              {error && (
                <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
                  {error}
                </div>
              )}

              {!generatedKey ? (
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="text-[#8BA4C8] text-xs font-semibold uppercase tracking-wider mb-2 block">Key Name</label>
                    <input
                      type="text"
                      placeholder="e.g. Cursor IDE — Production"
                      value={newKeyName}
                      onChange={e => setNewKeyName(e.target.value)}
                      autoFocus
                      className="input-glass px-4 py-3 text-sm rounded-xl w-full"
                      onKeyDown={e => e.key === 'Enter' && handleCreate()}
                    />
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={handleCreate}
                      disabled={creating || !newKeyName.trim()}
                      className="btn-gradient text-white font-semibold px-5 py-2.5 rounded-xl text-sm disabled:opacity-50 flex items-center gap-2"
                    >
                      {creating ? (
                        <>
                          <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 12a9 9 0 11-6.219-8.56" />
                          </svg>
                          Creating...
                        </>
                      ) : 'Generate Key'}
                    </button>
                    <button onClick={() => setShowCreateForm(false)} className="text-[#4A6280] hover:text-[#8BA4C8] font-medium px-4 py-2.5 rounded-xl text-sm border border-white/10 hover:border-white/20 transition-all">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4">
                  <div className="p-1 pl-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-2">
                    <code className="text-emerald-400 font-mono text-sm flex-1 break-all">{generatedKey}</code>
                    <button
                      onClick={() => handleCopy(generatedKey, 'generated')}
                      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs transition-all flex-shrink-0 ${
                        copiedStates['generated']
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-white/5 text-[#8BA4C8] border border-white/10 hover:text-[#F0F6FF]'
                      }`}
                    >
                      {copiedStates['generated'] ? (
                        <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>Copied!</>
                      ) : (
                        <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>Copy</>
                      )}
                    </button>
                  </div>
                  <p className="text-amber-400 text-xs flex items-start gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 flex-shrink-0">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    Save this key securely — it will not be shown again.
                  </p>
                  <button onClick={() => setShowCreateForm(false)} className="btn-gradient text-white font-semibold px-5 py-2.5 rounded-xl text-sm w-fit">
                    Done
                  </button>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Keys table */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="glass-card rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/8">
          <h3 className="text-[#F0F6FF] font-semibold text-sm">{keys.length} API Key{keys.length !== 1 ? 's' : ''}</h3>
        </div>

        {loading ? (
          <div className="p-6 flex flex-col gap-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="shimmer h-12 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left px-6 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Name</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Key</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Created</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Last Used</th>
                  <th className="text-left px-4 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Status</th>
                  <th className="text-right px-6 py-3 text-[#4A6280] text-xs font-semibold uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} className={`border-b border-white/5 last:border-0 transition-all ${!key.is_active ? 'opacity-50' : 'hover:bg-white/[0.02]'}`}>
                    <td className="px-6 py-4">
                      <span className="text-[#F0F6FF] text-sm font-medium">{key.name}</span>
                    </td>
                    <td className="px-4 py-4">
                      <code className="text-[#8BA4C8] font-mono text-xs bg-white/5 px-2 py-1 rounded">
                        {key.key_prefix}
                      </code>
                    </td>
                    <td className="px-4 py-4">
                      <span className="text-[#4A6280] text-xs">{formatDate(key.created_at)}</span>
                    </td>
                    <td className="px-4 py-4">
                      <span className="text-[#4A6280] text-xs">{formatDate(key.last_used_at)}</span>
                    </td>
                    <td className="px-4 py-4">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${
                        key.is_active
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : 'bg-red-500/10 text-red-400 border-red-500/20'
                      }`}>
                        {key.is_active ? 'Active' : 'Revoked'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {key.is_active && (
                        revokeConfirm === key.id ? (
                          <div className="flex items-center gap-2 justify-end">
                            <span className="text-[#4A6280] text-xs">Confirm?</span>
                            <button onClick={() => handleRevoke(key.id)} className="text-red-400 hover:text-red-300 text-xs font-semibold px-2 py-1 rounded bg-red-500/10 border border-red-500/20">Yes, revoke</button>
                            <button onClick={() => setRevokeConfirm(null)} className="text-[#4A6280] hover:text-[#8BA4C8] text-xs px-2 py-1 rounded border border-white/10">Cancel</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setRevokeConfirm(key.id)}
                            className="text-red-400 hover:text-red-300 text-xs font-medium px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 transition-all"
                          >
                            Revoke
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && keys.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <div className="text-[#4A6280] text-sm">No API keys yet</div>
            <button onClick={() => setShowCreateForm(true)} className="btn-gradient text-white font-semibold px-4 py-2 rounded-xl text-sm">
              Create First Key
            </button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
