'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export type CredentialRow = {
  role: string
  username: string
  password: string
}

export type ProjectSettings = {
  projectKey: string
  projectName: string
  defaultStartCommand: string
  defaultBaseUrl: string
  defaultPort: number | null
  defaultTestType: 'frontend' | 'backend' | 'both'
  defaultPrd: string
  credentials: CredentialRow[]
  autoApply: boolean
  updatedAt: string | null
}

interface Props {
  workspaceId: string
  workspaceProjectKey: string
  initial: ProjectSettings | null
  isOwner: boolean
}

function blankCredential(): CredentialRow {
  return { role: '', username: '', password: '' }
}

export default function SettingsForm({ workspaceId, workspaceProjectKey, initial, isOwner }: Props) {
  const router = useRouter()
  const [projectKey, setProjectKey] = useState(initial?.projectKey ?? workspaceProjectKey)
  const [projectName, setProjectName] = useState(initial?.projectName ?? '')
  const [defaultStartCommand, setDefaultStartCommand] = useState(initial?.defaultStartCommand ?? '')
  const [defaultBaseUrl, setDefaultBaseUrl] = useState(initial?.defaultBaseUrl ?? '')
  const [defaultPort, setDefaultPort] = useState<string>(
    initial?.defaultPort != null ? String(initial.defaultPort) : ''
  )
  const [defaultTestType, setDefaultTestType] = useState<ProjectSettings['defaultTestType']>(
    initial?.defaultTestType ?? 'both'
  )
  const [defaultPrd, setDefaultPrd] = useState(initial?.defaultPrd ?? '')
  const [credentials, setCredentials] = useState<CredentialRow[]>(
    initial?.credentials?.length ? initial.credentials : [blankCredential()]
  )
  const [revealIndex, setRevealIndex] = useState<Set<number>>(new Set())
  const [autoApply, setAutoApply] = useState(initial?.autoApply ?? true)

  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const isExistingRow = Boolean(initial)

  const updateCred = (idx: number, patch: Partial<CredentialRow>) => {
    setCredentials((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, ...patch } : row))
    )
  }

  const removeCred = (idx: number) => {
    setCredentials((prev) => (prev.length === 1 ? [blankCredential()] : prev.filter((_, i) => i !== idx)))
  }

  const toggleReveal = (idx: number) => {
    setRevealIndex((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setToast(null)
    try {
      const cleanedCreds = credentials
        .map((c) => ({
          role: c.role.trim(),
          username: c.username.trim(),
          password: c.password,
        }))
        .filter((c) => c.role || c.username || c.password)

      const body = {
        projectKey: projectKey.trim(),
        projectName: projectName.trim() || null,
        defaultStartCommand: defaultStartCommand.trim() || null,
        defaultBaseUrl: defaultBaseUrl.trim() || null,
        defaultPort: defaultPort.trim() ? Number(defaultPort) : null,
        defaultTestType,
        defaultPrd: defaultPrd || null,
        credentials: cleanedCreds,
        autoApply,
      }

      const res = await fetch(`/api/workspaces/${workspaceId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j?.error || `HTTP ${res.status}`)
      }
      setToast({ kind: 'ok', text: isExistingRow ? 'Settings updated.' : 'Project saved.' })
      // Re-fetch SSR so the rail picks up the new row.
      router.refresh()
    } catch (err) {
      setToast({ kind: 'err', text: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async () => {
    if (!isExistingRow || !isOwner) return
    if (!confirm(`Delete settings for "${projectName || projectKey}"? This cannot be undone.`)) return
    setDeleting(true)
    setToast(null)
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/settings?projectKey=${encodeURIComponent(projectKey)}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j?.error || `HTTP ${res.status}`)
      }
      router.push(`/workspace/${workspaceId}/settings`)
      router.refresh()
    } catch (err) {
      setToast({ kind: 'err', text: (err as Error).message })
      setDeleting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[#F0F6FF] text-lg font-bold">
            {isExistingRow ? 'Edit project' : 'New project'}
          </h2>
          {initial?.updatedAt && (
            <p className="text-[#4A6280] text-[10px] font-mono mt-1">
              Last saved {new Date(initial.updatedAt).toLocaleString()}
            </p>
          )}
        </div>
        <span
          className={`text-[10px] uppercase tracking-widest font-semibold px-2 py-1 rounded ${
            autoApply
              ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
              : 'bg-white/5 border border-white/10 text-[#8BA4C8]'
          }`}
        >
          Auto-apply: {autoApply ? 'on' : 'off'}
        </span>
      </div>

      {/* Identity */}
      <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">
            Project key
          </span>
          <input
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value)}
            readOnly={isExistingRow}
            placeholder="sha256(git-remote) or project name"
            className="input-glass px-3 py-2 text-sm rounded-lg font-mono disabled:opacity-60 read-only:opacity-60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">
            Display name
          </span>
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="pulseboard"
            className="input-glass px-3 py-2 text-sm rounded-lg"
          />
        </label>
      </fieldset>

      {/* Runtime */}
      <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">
            Start command
          </span>
          <input
            value={defaultStartCommand}
            onChange={(e) => setDefaultStartCommand(e.target.value)}
            placeholder="npm run start"
            className="input-glass px-3 py-2 text-sm rounded-lg font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">
            Base URL
          </span>
          <input
            value={defaultBaseUrl}
            onChange={(e) => setDefaultBaseUrl(e.target.value)}
            placeholder="http://localhost:8080"
            className="input-glass px-3 py-2 text-sm rounded-lg font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">
            Port
          </span>
          <input
            value={defaultPort}
            onChange={(e) => setDefaultPort(e.target.value.replace(/[^\d]/g, ''))}
            placeholder="8080"
            inputMode="numeric"
            className="input-glass px-3 py-2 text-sm rounded-lg font-mono"
          />
        </label>
      </fieldset>

      <fieldset>
        <legend className="text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold mb-2">
          Test type
        </legend>
        <div className="flex flex-wrap gap-2">
          {(['frontend', 'backend', 'both'] as const).map((t) => (
            <label
              key={t}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-xs border transition-colors ${
                defaultTestType === t
                  ? 'bg-blue-500/10 border-blue-500/30 text-[#F0F6FF]'
                  : 'bg-white/[0.02] border-white/10 text-[#8BA4C8] hover:text-[#F0F6FF]'
              }`}
            >
              <input
                type="radio"
                name="testType"
                value={t}
                checked={defaultTestType === t}
                onChange={() => setDefaultTestType(t)}
                className="accent-blue-500"
              />
              <span className="capitalize">{t}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* PRD */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">
          PRD (markdown)
        </span>
        <textarea
          value={defaultPrd}
          onChange={(e) => setDefaultPrd(e.target.value)}
          placeholder="# PRD&#10;## Feature: ..."
          rows={10}
          className="input-glass px-3 py-2 text-xs rounded-lg font-mono"
        />
        <span className="text-[10px] text-[#4A6280]">
          Paste your PRD here. Auto-parsed into ACs at apply time.
        </span>
      </label>

      {/* Credentials */}
      <fieldset className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <legend className="text-[10px] uppercase tracking-widest text-[#4A6280] font-semibold">
            Credentials (encrypted at rest)
          </legend>
          <button
            type="button"
            onClick={() => setCredentials((c) => [...c, blankCredential()])}
            className="text-[10px] uppercase tracking-widest font-semibold text-[#60A5FA] hover:text-[#F0F6FF]"
          >
            + Add role
          </button>
        </div>
        <div className="flex flex-col gap-2">
          {credentials.map((c, idx) => {
            const revealed = revealIndex.has(idx)
            return (
              <div
                key={idx}
                className="grid grid-cols-1 sm:grid-cols-[120px_1fr_1fr_auto_auto] gap-2 items-center"
              >
                <input
                  value={c.role}
                  onChange={(e) => updateCred(idx, { role: e.target.value })}
                  placeholder="role"
                  className="input-glass px-2 py-1.5 text-xs rounded-lg font-mono"
                />
                <input
                  value={c.username}
                  onChange={(e) => updateCred(idx, { username: e.target.value })}
                  placeholder="username / email"
                  className="input-glass px-2 py-1.5 text-xs rounded-lg"
                />
                <input
                  type={revealed ? 'text' : 'password'}
                  value={c.password}
                  onChange={(e) => updateCred(idx, { password: e.target.value })}
                  placeholder="password"
                  className="input-glass px-2 py-1.5 text-xs rounded-lg font-mono"
                />
                <button
                  type="button"
                  onClick={() => toggleReveal(idx)}
                  className="text-[10px] uppercase tracking-widest text-[#60A5FA] hover:text-[#F0F6FF] px-2"
                  aria-label={revealed ? 'Hide password' : 'Show password'}
                >
                  {revealed ? 'hide' : 'show'}
                </button>
                <button
                  type="button"
                  onClick={() => removeCred(idx)}
                  className="text-[10px] uppercase tracking-widest text-red-300 hover:text-red-200 px-2"
                  aria-label="Remove credential"
                >
                  remove
                </button>
              </div>
            )
          })}
        </div>
      </fieldset>

      {/* Auto-apply */}
      <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg bg-white/[0.02] border border-white/10">
        <input
          type="checkbox"
          checked={autoApply}
          onChange={(e) => setAutoApply(e.target.checked)}
          className="mt-1 accent-blue-500"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-[#F0F6FF] text-xs font-semibold">Auto-apply on every run</span>
          <span className="text-[#8BA4C8] text-[11px]">
            When on, the MCP skips the config form entirely and uses these settings. Turn off if you
            want to review the form on each run.
          </span>
        </span>
      </label>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <button
          type="submit"
          disabled={saving || !projectKey.trim()}
          className="btn-gradient text-white font-semibold px-5 py-2 rounded-xl text-sm disabled:opacity-60"
        >
          {saving ? 'Saving…' : isExistingRow ? 'Save changes' : 'Create project'}
        </button>
        {isExistingRow && isOwner && (
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="text-xs uppercase tracking-widest font-semibold border border-red-500/30 text-red-300 hover:text-red-200 hover:border-red-500/60 px-3 py-2 rounded-lg disabled:opacity-60"
          >
            {deleting ? 'Deleting…' : 'Delete project'}
          </button>
        )}
        {toast && (
          <span
            className={`text-xs px-3 py-1 rounded ${
              toast.kind === 'ok'
                ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
                : 'bg-red-500/10 border border-red-500/30 text-red-300'
            }`}
          >
            {toast.text}
          </span>
        )}
      </div>
    </form>
  )
}
