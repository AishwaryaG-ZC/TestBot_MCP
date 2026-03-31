import { createSupabaseServerClient } from '../supabase/server'
import { db } from '../db'
import { profiles } from '../db/schema'
import { eq } from 'drizzle-orm'

export async function getCurrentUser() {
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

export async function getCurrentProfile() {
  const user = await getCurrentUser()
  if (!user) return null

  const [profile] = await db.select().from(profiles).where(eq(profiles.id, user.id)).limit(1)
  return { user, profile: profile ?? null }
}
