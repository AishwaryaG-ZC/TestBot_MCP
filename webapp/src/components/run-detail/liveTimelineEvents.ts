/**
 * CL-B (Claude-local adapter) — pure helpers for rendering new live-timeline
 * event types in `<LiveTimeline>`.
 *
 * Kept in a non-tsx module so unit tests can import the shape contract
 * without a React renderer. The page-level renderer in `test-run/[id]/page.tsx`
 * calls these and wraps the result in the existing timeline card.
 */

export type ClaudeAssistantMessageMeta = {
  message: string;
  iteration: number;
};

export type ClaudeFileEditedMeta = {
  path: string;
  action: 'create' | 'edit';
  iteration: number;
  lineCount?: number;
};

export type ClaudeIterationStartedMeta = {
  iteration: number;
  previousPassRate?: number;
  target: number;
};

export type ClaudeAwaitingUserQuestionMeta = {
  questionId: string;
  question: string;
  options?: string[];
  confidence: 'low' | 'medium' | 'high';
};

export type ClaudeAwaitingUserLoginMeta = {
  message: string;
  loginUrl?: string | null;
};

export const CLAUDE_EVENT_TYPES = new Set([
  'assistant_message',
  'file_edited',
  'iteration_started',
  'awaiting_user_question',
  'awaiting_user_login',
]);

export function isClaudeEvent(eventType: string | null | undefined): boolean {
  return Boolean(eventType && CLAUDE_EVENT_TYPES.has(eventType));
}

const ASSISTANT_MESSAGE_PREVIEW_LIMIT = 500;

/**
 * Truncate an assistant message to ~500 chars for the inline card.
 * Returns { preview, isTruncated }.
 */
export function previewAssistantMessage(message: string): {
  preview: string;
  isTruncated: boolean;
} {
  if (typeof message !== 'string') return { preview: '', isTruncated: false };
  if (message.length <= ASSISTANT_MESSAGE_PREVIEW_LIMIT) {
    return { preview: message, isTruncated: false };
  }
  return {
    preview: message.slice(0, ASSISTANT_MESSAGE_PREVIEW_LIMIT) + '…',
    isTruncated: true,
  };
}

/** Icon glyph for a file_edited event. */
export function fileEditIcon(action: 'create' | 'edit'): string {
  return action === 'create' ? '+' : '✎';
}

/** Build the iteration-divider label. */
export function buildIterationLabel(meta: ClaudeIterationStartedMeta): string {
  const targetPct = Math.round((meta.target ?? 0) * 100);
  if (typeof meta.previousPassRate === 'number') {
    const prevPct = Math.round(meta.previousPassRate * 100);
    return `Iteration ${meta.iteration} — chasing ${targetPct}% (was ${prevPct}%)`;
  }
  return `Iteration ${meta.iteration} — chasing ${targetPct}%`;
}
