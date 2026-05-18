'use client';

import { useState, useEffect } from 'react';

interface Workspace {
  id: string;
  projectKey: string;
  gitRemote: string | null;
  projectName: string;
  inviteCode: string;
  createdAt: string;
  role: string;
}

interface Member {
  userId: string;
  role: string;
  joinedAt: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={copy} className="text-[10px] font-mono font-bold text-[#505050] hover:text-white border border-[#333] hover:border-[#666] px-2 py-0.5 transition-colors">
      {copied ? 'COPIED' : 'COPY'}
    </button>
  );
}

function WorkspaceCard({ ws, onRefreshInvite, onViewCoverage, onDeleted }: {
  ws: Workspace;
  onRefreshInvite: (id: string) => void;
  onViewCoverage: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [membersOpen, setMembersOpen] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addLoading, setAddLoading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isOwner = ws.role === 'owner';

  const loadMembers = async () => {
    if (membersOpen) { setMembersOpen(false); return; }
    setLoadingMembers(true);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/members`);
      const json = await res.json();
      if (res.ok) setMembers(json.members || []);
    } catch { /* ignore */ } finally {
      setLoadingMembers(false);
      setMembersOpen(true);
    }
  };

  const handleAddMember = async () => {
    if (!addEmail.trim()) return;
    setAddLoading(true);
    setAddError(null);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: addEmail.trim() }),
      });
      const json = await res.json();
      if (res.ok || res.status === 201) {
        setAddEmail('');
        setMembers((prev) => [...prev, json.member]);
      } else {
        setAddError(json.error || 'Failed to add member');
      }
    } catch {
      setAddError('Network error');
    } finally {
      setAddLoading(false);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    setRemovingId(userId);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        setMembers((prev) => prev.filter((m) => m.userId !== userId));
      }
    } catch { /* ignore */ } finally {
      setRemovingId(null);
    }
  };

  const handleDeleteWorkspace = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}`, { method: 'DELETE' });
      if (res.ok) onDeleted(ws.id);
    } catch { /* ignore */ } finally {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  };

  const projectKeyValue = ws.gitRemote || ws.projectName;

  const mcpConfigSnippet = `"env": {
  "HEALIX_API_KEY": "<your-api-key>",
  "HEALIX_DASHBOARD_URL": "<dashboard-url>",
  "HEALIX_PROJECT_KEY": "${projectKeyValue}"
}`;

  const aiAgentPrompt =
    `Please add HEALIX_PROJECT_KEY to my Healix MCP server configuration.\n\n` +
    `Add the following key-value pair to the "env" block of the "healix-mcp" entry in my MCP config file ` +
    `(~/.claude/settings.json for Claude Code, ~/.cursor/mcp.json for Cursor, ` +
    `~/.codeium/windsurf/mcp_config.json for Windsurf):\n\n` +
    `"HEALIX_PROJECT_KEY": "${projectKeyValue}"\n\n` +
    `This links me to the "${ws.projectName}" team workspace so Healix can share test coverage with my teammates.`;

  return (
    <div className="border-2 border-[#222] bg-[#0a0a0a] p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-white font-black font-mono text-sm uppercase tracking-wider">{ws.projectName}</div>
          {ws.gitRemote && (
            <div className="text-[#505050] font-mono text-[11px] mt-0.5">{ws.gitRemote}</div>
          )}
        </div>
        <span className={`text-[9px] font-mono font-black px-2 py-0.5 border ${isOwner ? 'border-white text-white' : 'border-[#444] text-[#888]'} uppercase tracking-wider flex-shrink-0`}>
          {ws.role}
        </span>
      </div>

      {/* Invite Code */}
      <div className="bg-[#050505] border border-[#1a1a1a] p-2">
        <div className="text-[9px] font-mono text-[#505050] uppercase tracking-widest mb-1">Invite Code</div>
        <div className="flex items-center gap-2">
          <code className="text-[#a0a0a0] font-mono text-xs flex-1 truncate">{ws.inviteCode}</code>
          <CopyButton text={ws.inviteCode} />
          {isOwner && (
            <button
              onClick={() => onRefreshInvite(ws.id)}
              className="text-[10px] font-mono font-bold text-[#505050] hover:text-white border border-[#333] hover:border-[#666] px-2 py-0.5 transition-colors"
            >
              ROTATE
            </button>
          )}
        </div>
      </div>

      {/* Project Key */}
      <div className="bg-[#050505] border border-[#1a1a1a] p-2">
        <div className="text-[9px] font-mono text-[#505050] uppercase tracking-widest mb-1">Project Key</div>
        <div className="flex items-center gap-2">
          <code className="text-[#a0a0a0] font-mono text-xs flex-1 truncate">{projectKeyValue}</code>
          <CopyButton text={projectKeyValue} />
        </div>
        <div className="text-[9px] font-mono text-[#333] mt-1">
          Teammates without git access need this to link their MCP config.
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={loadMembers}
          disabled={loadingMembers}
          className="flex-1 text-[10px] font-mono font-bold uppercase tracking-widest border border-[#333] hover:border-[#666] text-[#888] hover:text-white py-1.5 transition-colors disabled:opacity-40"
        >
          {loadingMembers ? '...' : membersOpen ? 'HIDE SETTINGS' : 'SETTINGS'}
        </button>
        <button
          onClick={() => setSetupOpen((v) => !v)}
          className="flex-1 text-[10px] font-mono font-bold uppercase tracking-widest border border-[#333] hover:border-[#666] text-[#888] hover:text-white py-1.5 transition-colors"
        >
          {setupOpen ? 'HIDE SETUP' : 'SETUP INSTRUCTIONS'}
        </button>
        <button
          onClick={() => onViewCoverage(ws.id)}
          className="flex-1 text-[10px] font-mono font-bold uppercase tracking-widest border border-[#333] hover:border-white text-[#888] hover:text-white py-1.5 transition-colors"
        >
          COVERAGE MAP →
        </button>
      </div>

      {/* Setup Instructions */}
      {setupOpen && (
        <div className="border-t border-[#1a1a1a] pt-3 space-y-3">
          <div className="text-[9px] font-mono text-[#505050] uppercase tracking-widest font-black">Setup for Teammates</div>
          <p className="text-[10px] font-mono text-[#505050]">
            Teammates who have the repo cloned are auto-identified via git remote — no extra config needed.
            For teammates using a zip or without git access, share these instructions:
          </p>
          <div>
            <div className="text-[9px] font-mono text-[#505050] uppercase tracking-widest mb-1">Step 1 — Join the workspace</div>
            <div className="text-[10px] font-mono text-[#505050]">
              Share your invite code: <code className="text-[#a0a0a0]">{ws.inviteCode}</code>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[9px] font-mono text-[#505050] uppercase tracking-widest">Step 2 — Add project key to MCP config</div>
              <CopyButton text={mcpConfigSnippet} />
            </div>
            <pre className="bg-black border border-[#1a1a1a] text-[#a0a0a0] font-mono text-[10px] p-3 overflow-x-auto whitespace-pre">{mcpConfigSnippet}</pre>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[9px] font-mono text-[#505050] uppercase tracking-widest">Or — paste this into your AI chat agent</div>
              <CopyButton text={aiAgentPrompt} />
            </div>
            <pre className="bg-black border border-[#1a1a1a] text-[#606060] font-mono text-[10px] p-3 overflow-x-auto whitespace-pre-wrap">{aiAgentPrompt}</pre>
          </div>
        </div>
      )}

      {/* Members list */}
      {membersOpen && (
        <div className="border-t border-[#1a1a1a] pt-3 space-y-2">
          {members.length === 0 ? (
            <div className="text-[#505050] font-mono text-xs">No members found</div>
          ) : (
            members.map((m) => (
              <div key={m.userId} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-white font-mono text-[11px] truncate">{m.fullName || m.email}</div>
                  {m.fullName && <div className="text-[#505050] font-mono text-[10px] truncate">{m.email}</div>}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`text-[9px] font-mono px-1.5 py-0.5 border ${m.role === 'owner' ? 'border-white text-white' : 'border-[#333] text-[#505050]'} uppercase`}>
                    {m.role}
                  </span>
                  {isOwner && m.role !== 'owner' && (
                    <button
                      onClick={() => handleRemoveMember(m.userId)}
                      disabled={removingId === m.userId}
                      className="text-[9px] font-mono font-bold text-red-600 hover:text-red-400 border border-red-900 hover:border-red-600 px-1.5 py-0.5 transition-colors disabled:opacity-40"
                    >
                      {removingId === m.userId ? '...' : 'REMOVE'}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}

          {/* Add member (owner only) */}
          {isOwner && (
            <div className="pt-2 border-t border-[#1a1a1a] space-y-1.5">
              <div className="text-[9px] font-mono text-[#505050] uppercase tracking-widest">Add Member by Email</div>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={addEmail}
                  onChange={(e) => { setAddEmail(e.target.value); setAddError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddMember(); }}
                  placeholder="teammate@example.com"
                  className="flex-1 bg-black border border-[#333] focus:border-white text-white font-mono text-xs px-3 py-1.5 outline-none min-w-0"
                />
                <button
                  onClick={handleAddMember}
                  disabled={addLoading || !addEmail.trim()}
                  className="text-[10px] font-mono font-bold uppercase tracking-widest border border-[#555] hover:border-white text-[#888] hover:text-white px-3 py-1.5 transition-colors disabled:opacity-40 flex-shrink-0"
                >
                  {addLoading ? '...' : 'ADD'}
                </button>
              </div>
              {addError && (
                <div className="text-red-400 font-mono text-[10px]">{addError}</div>
              )}
            </div>
          )}

          {/* Delete workspace (owner only) */}
          {isOwner && (
            <div className="pt-3 border-t border-[#1a1a1a]">
              {!deleteConfirm ? (
                <button
                  onClick={() => setDeleteConfirm(true)}
                  className="text-[10px] font-mono font-bold uppercase tracking-widest border border-red-900 hover:border-red-500 text-red-700 hover:text-red-400 px-3 py-1.5 transition-colors w-full"
                >
                  DELETE WORKSPACE
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="text-[10px] font-mono text-red-400">
                    This permanently deletes the workspace, all shared test files, and coverage history. Cannot be undone.
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleDeleteWorkspace}
                      disabled={deleting}
                      className="flex-1 text-[10px] font-mono font-bold uppercase tracking-widest border border-red-500 bg-red-950 text-red-400 hover:bg-red-900 px-3 py-1.5 transition-colors disabled:opacity-40"
                    >
                      {deleting ? 'DELETING...' : 'YES, DELETE'}
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(false)}
                      className="flex-1 text-[10px] font-mono font-bold uppercase tracking-widest border border-[#333] text-[#888] hover:text-white px-3 py-1.5 transition-colors"
                    >
                      CANCEL
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function WorkspacePage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [createForm, setCreateForm] = useState({ projectName: '', gitRemote: '', projectKey: '' });
  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [coverageWorkspaceId, setCoverageWorkspaceId] = useState<string | null>(null);

  useEffect(() => { fetchWorkspaces(); }, []);

  const fetchWorkspaces = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/workspaces');
      const json = await res.json();
      if (res.ok) {
        setWorkspaces(json.workspaces || []);
      } else if (res.status === 403) {
        setError(json.message || 'Team workspaces require a paid plan. Upgrade to access this feature.');
      } else {
        setError(json.error || 'Failed to load workspaces');
      }
    } catch {
      setError('Network error — could not load workspaces');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!createForm.projectName.trim() || !createForm.gitRemote.trim()) return;
    setCreating(true);
    try {
      const projectKey = createForm.projectKey.trim() || createForm.gitRemote.trim() || createForm.projectName.trim();
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectKey,
          gitRemote: createForm.gitRemote.trim() || null,
          projectName: createForm.projectName.trim(),
        }),
      });
      const json = await res.json();
      if (res.ok || res.status === 201) {
        setShowCreate(false);
        setCreateForm({ projectName: '', gitRemote: '', projectKey: '' });
        await fetchWorkspaces();
      } else {
        setError(json.error || 'Failed to create workspace');
      }
    } catch {
      setError('Failed to create workspace');
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    setJoining(true);
    try {
      const res = await fetch('/api/workspaces/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteCode: joinCode.trim() }),
      });
      const json = await res.json();
      if (res.ok || res.status === 201) {
        setShowJoin(false);
        setJoinCode('');
        await fetchWorkspaces();
      } else {
        setError(json.error || 'Invalid invite code');
      }
    } catch {
      setError('Failed to join workspace');
    } finally {
      setJoining(false);
    }
  };

  const handleRefreshInvite = async (workspaceId: string) => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/invite/regenerate`, { method: 'POST' });
      if (res.ok) await fetchWorkspaces();
    } catch { /* ignore */ }
  };

  if (coverageWorkspaceId) {
    return <CoverageMapView workspaceId={coverageWorkspaceId} onBack={() => setCoverageWorkspaceId(null)} />;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-white font-black text-lg font-mono uppercase tracking-widest">Workspace</h1>
          <p className="text-[#505050] font-mono text-xs mt-1">Share generated tests with your team — every teammate pulls existing coverage before generating.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowJoin(true); setShowCreate(false); }}
            className="text-[10px] font-mono font-bold uppercase tracking-widest border border-[#444] hover:border-[#888] text-[#888] hover:text-white px-3 py-2 transition-colors"
          >
            JOIN
          </button>
          <button
            onClick={() => { setShowCreate(true); setShowJoin(false); }}
            className="text-[10px] font-mono font-bold uppercase tracking-widest border border-white text-white hover:bg-white hover:text-black px-3 py-2 transition-colors"
          >
            + CREATE
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="border-2 border-white bg-[#050505] p-4 space-y-3">
          <div className="text-[10px] font-mono font-black text-white uppercase tracking-widest">Create Workspace</div>
          <div className="space-y-2">
            <div>
              <label className="text-[9px] font-mono text-[#505050] uppercase tracking-widest block mb-1">Project Name *</label>
              <input
                type="text"
                value={createForm.projectName}
                onChange={(e) => setCreateForm((p) => ({ ...p, projectName: e.target.value }))}
                placeholder="my-app"
                className="w-full bg-black border border-[#333] text-white font-mono text-xs px-3 py-2 focus:border-white outline-none"
              />
            </div>
            <div>
              <label className="text-[9px] font-mono text-[#505050] uppercase tracking-widest block mb-1">Git Remote URL *</label>
              <input
                type="text"
                value={createForm.gitRemote}
                onChange={(e) => setCreateForm((p) => ({ ...p, gitRemote: e.target.value }))}
                placeholder="github.com/org/repo"
                className="w-full bg-black border border-[#333] text-white font-mono text-xs px-3 py-2 focus:border-white outline-none"
              />
              <div className="text-[9px] font-mono text-[#505050] mt-1">Used to auto-identify the project for all teammates. Must match their git remote.</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || !createForm.projectName.trim() || !createForm.gitRemote.trim()}
              className="text-[10px] font-mono font-bold uppercase tracking-widest border border-white text-white hover:bg-white hover:text-black px-4 py-2 transition-colors disabled:opacity-40"
            >
              {creating ? 'CREATING...' : 'CREATE'}
            </button>
            <button onClick={() => setShowCreate(false)} className="text-[10px] font-mono font-bold uppercase tracking-widest border border-[#333] text-[#888] hover:text-white px-4 py-2 transition-colors">
              CANCEL
            </button>
          </div>
        </div>
      )}

      {/* Join form */}
      {showJoin && (
        <div className="border-2 border-[#444] bg-[#050505] p-4 space-y-3">
          <div className="text-[10px] font-mono font-black text-white uppercase tracking-widest">Join Workspace</div>
          <div>
            <label className="text-[9px] font-mono text-[#505050] uppercase tracking-widest block mb-1">Invite Code</label>
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="Paste invite code from your teammate"
              className="w-full bg-black border border-[#333] text-white font-mono text-xs px-3 py-2 focus:border-white outline-none"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleJoin}
              disabled={joining || !joinCode.trim()}
              className="text-[10px] font-mono font-bold uppercase tracking-widest border border-white text-white hover:bg-white hover:text-black px-4 py-2 transition-colors disabled:opacity-40"
            >
              {joining ? 'JOINING...' : 'JOIN'}
            </button>
            <button onClick={() => setShowJoin(false)} className="text-[10px] font-mono font-bold uppercase tracking-widest border border-[#333] text-[#888] hover:text-white px-4 py-2 transition-colors">
              CANCEL
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="border-2 border-red-500/50 bg-red-500/10 p-3">
          <p className="text-red-400 font-mono text-xs">{error}</p>
          {error.includes('paid plan') && (
            <a href="/plan-billing" className="text-red-300 font-mono text-xs underline mt-1 block">Upgrade plan →</a>
          )}
        </div>
      )}

      {/* Workspace list */}
      {loading ? (
        <div className="text-[#505050] font-mono text-xs animate-pulse">Loading workspaces...</div>
      ) : workspaces.length === 0 && !error ? (
        <div className="border-2 border-[#1a1a1a] p-8 text-center space-y-3">
          <div className="text-[#333]">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 00-3-3.87" />
              <path d="M16 3.13a4 4 0 010 7.75" />
            </svg>
          </div>
          <div className="text-[#505050] font-mono text-xs uppercase tracking-wider">No workspaces yet</div>
          <div className="text-[#333] font-mono text-[10px]">Create a workspace for your project or join one with an invite code.</div>
        </div>
      ) : (
        <div className="space-y-3">
          {workspaces.map((ws) => (
            <WorkspaceCard
              key={ws.id}
              ws={ws}
              onRefreshInvite={handleRefreshInvite}
              onViewCoverage={(id) => setCoverageWorkspaceId(id)}
              onDeleted={(id) => setWorkspaces((prev) => prev.filter((w) => w.id !== id))}
            />
          ))}
        </div>
      )}

      {/* How it works */}
      <div className="border border-[#1a1a1a] p-4 space-y-2">
        <div className="text-[9px] font-mono text-[#505050] uppercase tracking-widest font-black">How it works</div>
        <div className="space-y-1.5 text-[10px] font-mono text-[#505050]">
          <div className="flex gap-2"><span className="text-[#333] font-black">01</span><span>Create a workspace for your repo using the git remote URL</span></div>
          <div className="flex gap-2"><span className="text-[#333] font-black">02</span><span>Add teammates or share the invite code with teammates — they join once</span></div>
          <div className="flex gap-2"><span className="text-[#333] font-black">03</span><span>Every Healix run auto-pulls teammates&apos; test files before generating</span></div>
          <div className="flex gap-2"><span className="text-[#333] font-black">04</span><span>Generation runs only for uncovered routes, APIs, and categories</span></div>
          <div className="flex gap-2"><span className="text-[#333] font-black">05</span><span>New tests are pushed back so the next teammate benefits immediately</span></div>
        </div>
      </div>
    </div>
  );
}

// ── Inline coverage map view ──────────────────────────────────────────────────

function CoverageMapView({ workspaceId, onBack }: { workspaceId: string; onBack: () => void }) {
  const [coverage, setCoverage] = useState<{ covered: { routes: string[]; apiEndpoints: string[]; categories: string[]; requirements: string[] }; totalTargets: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'route' | 'api' | 'category' | 'requirement'>('route');

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/coverage`)
      .then((r) => r.json())
      .then((d) => { setCoverage(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [workspaceId]);

  const tabs: Array<{ key: 'route' | 'api' | 'category' | 'requirement'; label: string; items: string[] }> = [
    { key: 'route', label: 'Routes', items: coverage?.covered.routes || [] },
    { key: 'api', label: 'API Endpoints', items: coverage?.covered.apiEndpoints || [] },
    { key: 'category', label: 'Categories', items: coverage?.covered.categories || [] },
    { key: 'requirement', label: 'Requirements', items: coverage?.covered.requirements || [] },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-[#505050] hover:text-white font-mono text-[10px] uppercase tracking-widest border border-[#333] hover:border-[#666] px-2 py-1 transition-colors">
          ← BACK
        </button>
        <h2 className="text-white font-black font-mono text-sm uppercase tracking-widest">Coverage Map</h2>
      </div>

      {loading ? (
        <div className="text-[#505050] font-mono text-xs animate-pulse">Loading coverage...</div>
      ) : !coverage ? (
        <div className="text-[#505050] font-mono text-xs">No coverage data yet — run Healix to start building the registry.</div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3">
            {tabs.map((t) => (
              <div key={t.key} className="border border-[#222] bg-[#0a0a0a] p-3 text-center">
                <div className="text-white font-black font-mono text-xl">{t.items.length}</div>
                <div className="text-[#505050] font-mono text-[9px] uppercase tracking-widest mt-1">{t.label}</div>
              </div>
            ))}
          </div>

          <div className="flex gap-1 border-b border-[#222]">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-2 transition-colors border-b-2 -mb-px ${
                  activeTab === t.key ? 'border-white text-white' : 'border-transparent text-[#505050] hover:text-white'
                }`}
              >
                {t.label} ({t.items.length})
              </button>
            ))}
          </div>

          <div className="space-y-1">
            {tabs.find((t) => t.key === activeTab)?.items.map((item, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 border border-[#1a1a1a] bg-[#050505]">
                <div className="w-1.5 h-1.5 bg-green-400 flex-shrink-0" />
                <code className="text-[#a0a0a0] font-mono text-xs">{item}</code>
              </div>
            )) || []}
            {tabs.find((t) => t.key === activeTab)?.items.length === 0 && (
              <div className="text-[#505050] font-mono text-xs py-4 text-center">No {activeTab} coverage recorded yet</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
