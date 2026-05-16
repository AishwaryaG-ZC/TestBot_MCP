import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { workspaceMembers, workspaceProjectSettings } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireWorkspaceAuth } from '@/lib/workspace-auth'
import { encryptJson, decryptJson, type EncryptedEnvelope } from '@/lib/crypto-aes'

export const runtime = 'nodejs'

/**
 * WS-1 — per-workspace, per-project saved defaults.
 *
 * Auth: requireWorkspaceAuth (cookie session OR x-api-key). Caller MUST be a
 * member of the workspace (else 403). DELETE additionally requires the
 * caller be a workspace owner.
 *
 * Endpoints:
 *   GET    ?projectKey=X            — return row with decrypted creds, or 404
 *   PUT    body { projectKey, ... } — upsert by (workspaceId, projectKey)
 *   DELETE ?projectKey=X            — owners only; removes the row
 *
 * Credentials are AES-256-GCM encrypted at rest (crypto-aes.ts). Decrypted
 * values are returned on GET only — never logged.
 */

type CredentialRow = { role: string; username: string; password: string }

function isCredentialArray(value: unknown): value is CredentialRow[] {
  if (!Array.isArray(value)) return false
  return value.every(
    (row) =>
      row &&
      typeof row === 'object' &&
      typeof (row as Record<string, unknown>).role === 'string' &&
      typeof (row as Record<string, unknown>).username === 'string' &&
      typeof (row as Record<string, unknown>).password === 'string'
  )
}

async function getMembership(workspaceId: string, userId: string) {
  const [m] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))
    )
    .limit(1)
  return m ?? null
}

function rowToResponse(
  row: typeof workspaceProjectSettings.$inferSelect,
  decryptedCredentials: CredentialRow[] | null
) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectKey: row.projectKey,
    projectName: row.projectName,
    defaultStartCommand: row.defaultStartCommand,
    defaultBaseUrl: row.defaultBaseUrl,
    defaultPort: row.defaultPort,
    defaultTestType: row.defaultTestType,
    defaultPrd: row.defaultPrd,
    defaultAcs: row.defaultAcs,
    credentials: decryptedCredentials,
    hasCredentials: Boolean(row.credentialsEncrypted),
    autoApply: row.autoApply,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt?.toISOString?.() ?? null,
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params
  const url = new URL(request.url)
  const projectKey = url.searchParams.get('projectKey')

  const membership = await getMembership(workspaceId, auth.user.userId)
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // No projectKey → list all settings rows for this workspace (used by the
  // settings index page to enumerate configured projects).
  if (!projectKey) {
    const rows = await db
      .select()
      .from(workspaceProjectSettings)
      .where(eq(workspaceProjectSettings.workspaceId, workspaceId))
    // Don't return decrypted credentials in list view — only the hasCredentials
    // boolean. The detail GET (with projectKey) is the only path that returns
    // plaintext credentials.
    return NextResponse.json({
      settings: rows.map((r) => rowToResponse(r, null)),
    })
  }

  const [row] = await db
    .select()
    .from(workspaceProjectSettings)
    .where(
      and(
        eq(workspaceProjectSettings.workspaceId, workspaceId),
        eq(workspaceProjectSettings.projectKey, projectKey)
      )
    )
    .limit(1)

  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let decryptedCredentials: CredentialRow[] | null = null
  if (row.credentialsEncrypted && row.credentialsIv && row.credentialsTag) {
    try {
      decryptedCredentials = decryptJson<CredentialRow[]>({
        ciphertext: row.credentialsEncrypted,
        iv: row.credentialsIv,
        authTag: row.credentialsTag,
      })
    } catch (err) {
      // Tampered or key-rotated ciphertext — return the row without creds
      // so the operator can re-enter them, but log the failure.
      console.error('[ws-settings:GET] failed to decrypt credentials', {
        workspaceId,
        projectKey,
        reason: (err as Error).message,
      })
      decryptedCredentials = null
    }
  }

  return NextResponse.json(rowToResponse(row, decryptedCredentials))
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params
  const membership = await getMembership(workspaceId, auth.user.userId)
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const projectKey =
    typeof body.projectKey === 'string' && body.projectKey.trim().length > 0
      ? body.projectKey.trim().slice(0, 256)
      : null
  if (!projectKey) {
    return NextResponse.json({ error: 'projectKey is required' }, { status: 400 })
  }

  const projectName =
    typeof body.projectName === 'string' ? body.projectName.slice(0, 256) : null
  const defaultStartCommand =
    typeof body.defaultStartCommand === 'string' ? body.defaultStartCommand.slice(0, 1000) : null
  const defaultBaseUrl =
    typeof body.defaultBaseUrl === 'string' ? body.defaultBaseUrl.slice(0, 1000) : null
  const defaultPort =
    typeof body.defaultPort === 'number' && Number.isFinite(body.defaultPort)
      ? Math.trunc(body.defaultPort)
      : null
  const defaultTestType =
    typeof body.defaultTestType === 'string' &&
    ['frontend', 'backend', 'both'].includes(body.defaultTestType)
      ? body.defaultTestType
      : null
  const defaultPrd =
    typeof body.defaultPrd === 'string' ? body.defaultPrd.slice(0, 500_000) : null
  const defaultAcs =
    body.defaultAcs && typeof body.defaultAcs === 'object' ? body.defaultAcs : null
  const autoApply = typeof body.autoApply === 'boolean' ? body.autoApply : true

  let credsEnvelope: EncryptedEnvelope | null = null
  if (body.credentials !== undefined && body.credentials !== null) {
    if (!isCredentialArray(body.credentials)) {
      return NextResponse.json(
        { error: 'credentials must be an array of {role,username,password}' },
        { status: 400 }
      )
    }
    if (body.credentials.length > 10) {
      return NextResponse.json({ error: 'credentials array too long (max 10)' }, { status: 400 })
    }
    if (body.credentials.length > 0) {
      try {
        credsEnvelope = encryptJson(body.credentials)
      } catch (err) {
        console.error('[ws-settings:PUT] credential encryption failed', {
          reason: (err as Error).message,
        })
        return NextResponse.json(
          { error: 'Server misconfiguration: HEALIX_WORKSPACE_SECRET_KEY missing or invalid.' },
          { status: 500 }
        )
      }
    }
  }

  const setValues = {
    projectName,
    defaultStartCommand,
    defaultBaseUrl,
    defaultPort,
    defaultTestType,
    defaultPrd,
    defaultAcs,
    autoApply,
    updatedAt: new Date(),
    // Only overwrite credentials when the caller explicitly sent them.
    // Sending `credentials: null` clears them; omitting the field preserves.
    ...(body.credentials !== undefined
      ? {
          credentialsEncrypted: credsEnvelope?.ciphertext ?? null,
          credentialsIv: credsEnvelope?.iv ?? null,
          credentialsTag: credsEnvelope?.authTag ?? null,
        }
      : {}),
  }

  // Upsert by (workspaceId, projectKey). Drizzle's onConflictDoUpdate is the
  // cleanest cross-driver path; the unique constraint declared in the schema
  // gives us the conflict target.
  const [row] = await db
    .insert(workspaceProjectSettings)
    .values({
      workspaceId,
      projectKey,
      projectName,
      defaultStartCommand,
      defaultBaseUrl,
      defaultPort,
      defaultTestType,
      defaultPrd,
      defaultAcs,
      autoApply,
      credentialsEncrypted: credsEnvelope?.ciphertext ?? null,
      credentialsIv: credsEnvelope?.iv ?? null,
      credentialsTag: credsEnvelope?.authTag ?? null,
      createdBy: auth.user.userId,
    })
    .onConflictDoUpdate({
      target: [workspaceProjectSettings.workspaceId, workspaceProjectSettings.projectKey],
      set: setValues,
    })
    .returning()

  // Re-decrypt for response so the caller can confirm what was stored
  // (round-trip sanity). If credentials weren't provided on this PUT but were
  // already present, return the previously-stored set.
  let decryptedCredentials: CredentialRow[] | null = null
  if (row.credentialsEncrypted && row.credentialsIv && row.credentialsTag) {
    try {
      decryptedCredentials = decryptJson<CredentialRow[]>({
        ciphertext: row.credentialsEncrypted,
        iv: row.credentialsIv,
        authTag: row.credentialsTag,
      })
    } catch {
      decryptedCredentials = null
    }
  }

  return NextResponse.json(rowToResponse(row, decryptedCredentials))
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireWorkspaceAuth(request)
  if ('error' in auth) return auth.error

  const { id: workspaceId } = await params
  const url = new URL(request.url)
  const projectKey = url.searchParams.get('projectKey')
  if (!projectKey) {
    return NextResponse.json({ error: 'projectKey is required' }, { status: 400 })
  }

  const membership = await getMembership(workspaceId, auth.user.userId)
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (membership.role !== 'owner') {
    return NextResponse.json(
      { error: 'Only workspace owners can delete project settings' },
      { status: 403 }
    )
  }

  await db
    .delete(workspaceProjectSettings)
    .where(
      and(
        eq(workspaceProjectSettings.workspaceId, workspaceId),
        eq(workspaceProjectSettings.projectKey, projectKey)
      )
    )

  return NextResponse.json({ success: true })
}
