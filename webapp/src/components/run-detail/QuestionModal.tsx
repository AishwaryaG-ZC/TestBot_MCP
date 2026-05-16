'use client';

import { useState } from 'react';

/**
 * CL-B (Claude-local adapter) — `<QuestionModal>`.
 *
 * Mounted on the run-detail page when an `awaiting_user_question` telemetry
 * event appears. Submits to `POST /api/test-runs/[runId]/answer` and unmounts
 * itself on success via `onSubmitted()`.
 *
 * If `options` is provided we render radio buttons; otherwise a free-text
 * `<textarea>`. The "Submit" button is disabled while the request is pending.
 */
export interface QuestionModalProps {
  runId: string;
  questionId: string;
  question: string;
  options?: string[] | null;
  confidence?: 'low' | 'medium' | 'high';
  onSubmitted: () => void;
}

// ── Pure helpers (testable without a DOM) ──────────────────────────────────

/** True when the modal should render radio buttons (options provided). */
export function shouldRenderOptions(options: string[] | null | undefined): boolean {
  return Array.isArray(options) && options.length > 0;
}

/**
 * Build the request init we POST to `/api/test-runs/[runId]/answer`. Returns
 * `{ url, init }` so the caller can pass to `fetch(url, init)`.
 */
export function buildAnswerRequest(
  runId: string,
  questionId: string,
  answer: string
): { url: string; init: RequestInit } {
  return {
    url: `/api/test-runs/${runId}/answer`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId, answer }),
    },
  };
}

const CONFIDENCE_COLOR: Record<'low' | 'medium' | 'high', string> = {
  low: 'bg-red-500/15 border-red-400/30 text-red-200',
  medium: 'bg-amber-500/15 border-amber-400/30 text-amber-200',
  high: 'bg-emerald-500/15 border-emerald-400/30 text-emerald-200',
};

export default function QuestionModal(props: QuestionModalProps) {
  const { runId, questionId, question, options, confidence, onSubmitted } =
    props;

  const hasOptions = Array.isArray(options) && options.length > 0;
  const [selected, setSelected] = useState<string>(
    hasOptions && options ? options[0] ?? '' : ''
  );
  const [freeText, setFreeText] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = hasOptions
    ? selected.length > 0 && !submitting
    : freeText.trim().length > 0 && !submitting;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    const answer = hasOptions ? selected : freeText.trim();
    try {
      const { url, init } = buildAnswerRequest(runId, questionId, answer);
      const res = await fetch(url, init);
      if (res.status === 204) {
        onSubmitted();
        return;
      }
      if (res.status === 409) {
        // Worker already drained → dashboard state is stale, dismiss.
        onSubmitted();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError((body as { error?: string }).error ?? `HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="question-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0E1525] p-6 shadow-2xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-[#F0F6FF]">
            Claude needs your input
          </span>
          {confidence && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-mono ${CONFIDENCE_COLOR[confidence]}`}
            >
              confidence: {confidence}
            </span>
          )}
        </div>
        <p className="mb-4 text-sm text-[#D8E8FF]">{question}</p>

        {hasOptions ? (
          <div className="mb-4 flex flex-col gap-2" data-testid="qm-options">
            {options!.map((opt) => (
              <label
                key={opt}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-[#D8E8FF] hover:border-blue-500/30"
              >
                <input
                  type="radio"
                  name={`qm-${questionId}`}
                  value={opt}
                  checked={selected === opt}
                  onChange={() => setSelected(opt)}
                  className="accent-blue-500"
                />
                <span>{opt}</span>
              </label>
            ))}
          </div>
        ) : (
          <textarea
            data-testid="qm-textarea"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            rows={4}
            placeholder="Type your answer…"
            className="mb-4 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-[#F0F6FF] placeholder:text-[#4A6280] focus:border-blue-500/30 focus:outline-none"
          />
        )}

        {error && (
          <div className="mb-3 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="flex justify-end">
          <button
            data-testid="qm-submit"
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="btn-gradient rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
