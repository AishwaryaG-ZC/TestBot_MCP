'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { TestList } from '@/lib/types/database';

function formatDate(iso: string | null) {
  if (!iso) return 'Never run';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function SkeletonCard() {
  return (
    <div className="glass-card rounded-2xl p-5 flex items-center gap-4">
      <div className="w-12 h-12 rounded-xl bg-white/5 animate-pulse flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-40 bg-white/5 rounded animate-pulse" />
        <div className="h-3 w-28 bg-white/5 rounded animate-pulse" />
        <div className="h-3 w-52 bg-white/5 rounded animate-pulse" />
      </div>
    </div>
  );
}

export default function TestListsPage() {
  const [lists, setLists] = useState<TestList[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Fetch lists from API on mount
  useEffect(() => {
    async function fetchLists() {
      setLoading(true);
      try {
        const res = await fetch('/api/test-lists');
        if (!res.ok) throw new Error('Failed to fetch test lists');
        const json = await res.json();
        setLists(json.data ?? []);
      } catch (err) {
        console.error(err);
        setError('Failed to load test lists. Please refresh.');
      } finally {
        setLoading(false);
      }
    }
    fetchLists();
  }, []);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    // Optimistic removal
    setTimeout(() => {
      setLists(prev => prev.filter(l => l.id !== id));
      setDeletingId(null);
    }, 300);
    // Note: DELETE API endpoint can be wired up later
  };

  const handleEdit = (list: TestList) => {
    setEditingId(list.id);
    setEditName(list.name);
  };

  const handleSaveEdit = (id: string) => {
    if (!editName.trim()) return;
    // Optimistic update (PATCH endpoint can be wired up later)
    setLists(prev => prev.map(l => l.id === id ? { ...l, name: editName.trim() } : l));
    setEditingId(null);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/test-lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || undefined }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? 'Failed to create list');
      }
      const json = await res.json();
      const created: TestList = json.data;
      setLists(prev => [created, ...prev]);
      setNewName('');
      setNewDesc('');
      setShowNewForm(false);
    } catch (err: any) {
      setError(err.message ?? 'Failed to create test list');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-5">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <h2 className="text-[#F0F6FF] font-bold text-xl">Test Lists</h2>
          <p className="text-[#4A6280] text-sm mt-0.5">Organize your tests into reusable collections</p>
        </div>
        <button
          onClick={() => setShowNewForm(true)}
          className="btn-gradient flex items-center gap-2 text-black font-semibold px-4 py-2.5 rounded-xl text-sm"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Test List
        </button>
      </motion.div>

      {/* Error banner */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="glass-card rounded-xl px-4 py-3 border border-red-500/30 flex items-center justify-between gap-3">
              <span className="text-red-400 text-sm">{error}</span>
              <button onClick={() => setError(null)} className="text-[#4A6280] hover:text-[#F0F6FF] transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* New list form */}
      <AnimatePresence>
        {showNewForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="glass-card rounded-2xl p-5 border-blue-500/30">
              <h3 className="text-[#F0F6FF] font-semibold text-sm mb-4">Create New Test List</h3>
              <div className="flex flex-col gap-3">
                <input
                  type="text"
                  placeholder="List name"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  autoFocus
                  className="input-glass px-4 py-2.5 text-sm rounded-xl w-full"
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
                />
                <input
                  type="text"
                  placeholder="Description (optional)"
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  className="input-glass px-4 py-2.5 text-sm rounded-xl w-full"
                />
                <div className="flex gap-2 items-center">
                  <button
                    onClick={handleCreate}
                    disabled={saving || !newName.trim()}
                    className="btn-gradient text-white font-semibold px-5 py-2 rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {saving ? (
                      <>
                        <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 12a9 9 0 11-6.219-8.56" />
                        </svg>
                        Creating...
                      </>
                    ) : 'Create'}
                  </button>
                  <button
                    onClick={() => { setShowNewForm(false); setNewName(''); setNewDesc(''); setError(null); }}
                    className="text-[#4A6280] hover:text-[#8BA4C8] font-medium px-4 py-2 rounded-xl text-sm border border-white/10 hover:border-white/20 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Loading skeletons */}
      {loading && (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {/* Lists */}
      {!loading && (
        <div className="flex flex-col gap-3">
          <AnimatePresence>
            {lists.map((list, i) => (
              <motion.div
                key={list.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{
                  opacity: deletingId === list.id ? 0 : 1,
                  x: deletingId === list.id ? 40 : 0,
                  y: 0,
                }}
                exit={{ opacity: 0, x: 40 }}
                transition={{ delay: i * 0.05, duration: deletingId === list.id ? 0.3 : 0.4 }}
                className="glass-card rounded-2xl p-5 flex items-center gap-4 hover:shadow-[0_0_20px_rgba(59,130,246,0.1)] transition-all group"
              >
                {/* Icon */}
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-700/20 border border-blue-500/20 flex items-center justify-center flex-shrink-0 group-hover:border-blue-500/40 transition-colors">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="1.8">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  </svg>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  {editingId === list.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        autoFocus
                        className="input-glass px-3 py-1.5 text-sm rounded-lg flex-1"
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveEdit(list.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                      <button onClick={() => handleSaveEdit(list.id)} className="text-emerald-400 hover:text-emerald-300 text-xs font-semibold px-2">Save</button>
                      <button onClick={() => setEditingId(null)} className="text-[#4A6280] hover:text-[#8BA4C8] text-xs px-2">Cancel</button>
                    </div>
                  ) : (
                    <div className="font-semibold text-[#F0F6FF] text-sm mb-0.5 group-hover:text-[#60A5FA] transition-colors cursor-default">{list.name}</div>
                  )}
                  <div className="flex items-center gap-3 text-xs text-[#4A6280]">
                    <span>{list.test_count ?? 0} tests</span>
                    <span>·</span>
                    <span>Last run: {formatDate(list.last_run_at)}</span>
                  </div>
                  {editingId !== list.id && list.description && (
                    <div className="text-[#4A6280] text-xs mt-0.5 truncate">{list.description}</div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <button
                    onClick={() => handleEdit(list)}
                    className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-[#4A6280] hover:text-[#F0F6FF] hover:border-white/20 transition-all"
                    title="Edit"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(list.id)}
                    className="w-8 h-8 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 hover:bg-red-500/20 transition-all"
                    title="Delete"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                    </svg>
                  </button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {lists.length === 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[#4A6280]">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                </svg>
              </div>
              <div className="text-center">
                <div className="text-[#F0F6FF] font-semibold mb-1">No test lists yet</div>
                <div className="text-[#4A6280] text-sm">Create your first test list to organize your tests</div>
              </div>
              <button onClick={() => setShowNewForm(true)} className="btn-gradient text-white font-semibold px-5 py-2.5 rounded-xl text-sm">
                Create Test List
              </button>
            </motion.div>
          )}
        </div>
      )}
    </div>
  );
}
