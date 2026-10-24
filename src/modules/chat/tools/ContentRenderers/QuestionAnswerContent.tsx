import React, { useState } from 'react';

import type { Question } from '@/shared/types';

type QuestionAnswerContentProps = {
  questions: Question[];
  answers: Record<string, string>;
  className?: string;
};

/**
 * Rendered by chat's ToolRenderer to show an AskUserQuestion tool's questions
 * and the answers the user picked.
 */
// Exception to the stateless ContentRenderer pattern: multi-question navigation requires local state.
export const QuestionAnswerContent: React.FC<QuestionAnswerContentProps> = ({
  questions,
  answers,
  className = '',
}) => {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  // Tool inputs are runtime data loaded from session transcripts and may be
  // malformed (e.g. `questions` arriving as a non-array). Guard with
  // Array.isArray so a single bad payload can't crash the whole chat view
  // with "e.map is not a function".
  if (!Array.isArray(questions) || questions.length === 0) {
    return null;
  }

  const hasAnyAnswer = Object.keys(answers || {}).length > 0;
  const total = questions.length;

  return (
    <div className={`space-y-2 ${className}`}>
      {questions.map((rawQuestion, idx) => {
        // Entries come from session transcripts and may be malformed; skip
        // anything that isn't a proper question object with a string prompt.
        if (!rawQuestion || typeof rawQuestion !== 'object' || typeof rawQuestion.question !== 'string') {
          return null;
        }
        const q = rawQuestion;
        const answer = answers?.[q.question];
        // `options` is typed as an array but comes from untrusted runtime data;
        // keep only valid entries so `.some`/`.map` below never throw.
        const options = Array.isArray(q.options)
          ? q.options.filter((opt) => opt && typeof opt === 'object' && typeof opt.label === 'string')
          : [];
        // Match one exact option before splitting a multi-select answer. A
        // single label may itself contain ", ".
        const answerLabels = typeof answer !== 'string'
          ? []
          : options.some((option) => option.label === answer)
            ? [answer]
            : answer.split(', ');
        const skipped = !answer;
        const isExpanded = expandedIdx === idx;

        return (
          <div
            key={idx}
            className="overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50/50 dark:border-neutral-700/50 dark:bg-neutral-800/30"
          >
            <button
              type="button"
              onClick={() => setExpandedIdx(isExpanded ? null : idx)}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
            >
              <div className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ${
                answerLabels.length > 0
                  ? 'bg-muted'
                  : 'bg-neutral-100 dark:bg-neutral-800'
              }`}>
                {answerLabels.length > 0 ? (
                  <svg className="h-2.5 w-2.5 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <div className="h-1.5 w-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {q.header && (
                    <span className="inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {q.header}
                    </span>
                  )}
                  {total > 1 && (
                    <span className="text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
                      {idx + 1}/{total}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs leading-snug text-neutral-600 dark:text-neutral-400">
                  {q.question}
                </div>

                {!isExpanded && answerLabels.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {answerLabels.map((lbl) => {
                      const isCustom = !options.some(o => o.label === lbl);
                      return (
                        <span
                          key={lbl}
                          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground"
                        >
                          {lbl}
                          {isCustom && (
                            <span className="text-[9px] font-normal text-muted-foreground">(custom)</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}

                {!isExpanded && skipped && hasAnyAnswer && (
                  <span className="mt-1 inline-block text-[10px] italic text-neutral-400 dark:text-neutral-500">
                    Skipped
                  </span>
                )}
              </div>

              <svg
                className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-neutral-400 transition-transform duration-200 dark:text-neutral-500 ${
                  isExpanded ? 'rotate-180' : ''
                }`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isExpanded && (
              <div className="border-t border-neutral-100 px-3 pb-2.5 pt-0.5 dark:border-neutral-700/40">
                <div className="ml-6.5 space-y-1">
                  {options.map((opt) => {
                    const wasSelected = answerLabels.includes(opt.label);
                    return (
                      <div
                        key={opt.label}
                        className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[12px] ${
                          wasSelected
                            ? 'border border-border bg-muted'
                            : 'text-neutral-400 dark:text-neutral-500'
                        }`}
                      >
                        <div className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${q.multiSelect ? 'rounded-[3px]' : 'rounded-full'} flex items-center justify-center border-[1.5px] ${
                          wasSelected
                            ? 'border-foreground bg-foreground'
                            : 'border-neutral-300 dark:border-neutral-600'
                        }`}>
                          {wasSelected && (
                            <svg className="h-2 w-2 text-background" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className={wasSelected ? 'font-medium text-neutral-900 dark:text-neutral-100' : ''}>
                            {opt.label}
                          </span>
                          {opt.description && (
                            <span className={`mt-0.5 block text-[11px] ${
                              wasSelected ? 'text-muted-foreground' : 'text-neutral-400 dark:text-neutral-600'
                            }`}>
                              {opt.description}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {answerLabels.filter(lbl => !options.some(o => o.label === lbl)).map(lbl => (
                    <div
                      key={lbl}
                      className="flex items-start gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-[12px]"
                    >
                      <div className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${q.multiSelect ? 'rounded-[3px]' : 'rounded-full'} flex items-center justify-center border-[1.5px] border-foreground bg-foreground`}>
                        <svg className="h-2 w-2 text-background" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-neutral-900 dark:text-neutral-100">{lbl}</span>
                        <span className="ml-1 text-[10px] text-muted-foreground">(custom)</span>
                      </div>
                    </div>
                  ))}

                  {skipped && hasAnyAnswer && (
                    <div className="px-2.5 py-1 text-[11px] italic text-neutral-400 dark:text-neutral-500">
                      No answer provided
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {!hasAnyAnswer && total === 1 && (
        <div className="text-[11px] italic text-neutral-400 dark:text-neutral-500">
          Skipped
        </div>
      )}
    </div>
  );
};
