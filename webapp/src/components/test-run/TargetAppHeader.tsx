'use client'

/**
 * Q1: Target App header.
 *
 * The dashboard's prior header was "MCP Run 0_xyz" — generic, useless for
 * QA managers who run multiple targets. This component surfaces the
 * target-app identity prominently so a reviewer landing on the page
 * immediately knows:
 *   - WHICH app is being tested
 *   - WHICH branch/commit/baseURL
 *   - WHEN the run happened
 *
 * The "MCP Run" identifier moves to a secondary line; it's a Healix-internal
 * identifier, not a QA-facing one.
 */

import Link from 'next/link'

interface TargetAppHeaderProps {
  /** Display name of the project under test, e.g. "thea" */
  projectName: string
  /** Original mcp_... run id (kept as secondary identifier) */
  mcpRunId?: string | null
  /** Git remote URL if known (e.g. github.com/foo/bar) */
  gitRemote?: string | null
  /** Branch tested (from Q5 repro context) */
  gitBranch?: string | null
  /** Commit SHA tested (from Q5 repro context) */
  gitCommit?: string | null
  /** Base URL the run hit (e.g. http://localhost:3002) */
  baseUrl?: string | null
  /** ISO-8601 timestamp of run start */
  startedAt?: string | null
}

function shortCommit(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha
}

function gitRemoteUrl(remote: string): string | null {
  if (!remote) return null
  if (remote.startsWith('http://') || remote.startsWith('https://')) return remote
  if (remote.startsWith('git@')) {
    // git@github.com:foo/bar.git → https://github.com/foo/bar
    const m = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
    if (m) return `https://${m[1]}/${m[2]}`
  }
  // bare "github.com/foo/bar"
  if (/^[^/]+\/[^/]+\/[^/]+$/.test(remote)) return `https://${remote}`
  return null
}

export function TargetAppHeader(props: TargetAppHeaderProps) {
  const remoteUrl = props.gitRemote ? gitRemoteUrl(props.gitRemote) : null
  return (
    <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-4" data-testid="target-app-header">
      <h1 className="text-2xl font-bold text-[#F0F6FF]">
        Testing: <span className="text-blue-300">{props.projectName}</span>
      </h1>
      {props.baseUrl && (
        <span className="text-[#8DA0BC] text-sm font-mono" title="Base URL the run hit">
          {props.baseUrl}
        </span>
      )}
      {remoteUrl ? (
        <Link
          href={remoteUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[#8DA0BC] text-xs hover:text-blue-300 underline"
        >
          {props.gitRemote}
        </Link>
      ) : props.gitRemote ? (
        <span className="text-[#8DA0BC] text-xs">{props.gitRemote}</span>
      ) : null}
      {(props.gitBranch || props.gitCommit) && (
        <span className="text-[#4A6280] text-xs font-mono">
          {props.gitBranch ? `@${props.gitBranch}` : ''}
          {props.gitCommit ? ` · ${shortCommit(props.gitCommit)}` : ''}
        </span>
      )}
      {props.mcpRunId && (
        <span className="text-[#4A6280] text-[10px] font-mono ml-auto" title="Internal Healix run identifier">
          run: {props.mcpRunId.slice(0, 28)}
        </span>
      )}
    </header>
  )
}

// Exported for tests
export { gitRemoteUrl }
