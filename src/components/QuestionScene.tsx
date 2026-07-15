import type { QuestionSceneContent } from "@/lib/question-scene-layout";
import { EXCALIFONT_STACK } from "@/lib/scene-font";
import {
  QUESTION_HINT_LABELS,
  QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
  QUESTION_MARK_SCREEN_TEXT_DEFAULT,
  questionRevealProgress,
} from "@/lib/question-scene-layout";

function FadeIn({
  progress,
  children,
  className,
}: {
  progress: number;
  children: React.ReactNode;
  className?: string;
}) {
  if (progress <= 0) return null;
  return (
    <div
      className={className}
      style={{
        opacity: progress,
        transform: `translateY(${(1 - progress) * 8}px)`,
        transition: "opacity 0.25s ease, transform 0.25s ease",
      }}
    >
      {children}
    </div>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 7.2 V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="5.2" r="0.8" fill="currentColor" />
    </svg>
  );
}

export function QuestionIntroScreen({
  embedded = false,
  introText = QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
}: {
  embedded?: boolean;
  introText?: string;
}) {
  const inner = (
    <div
      className="flex h-full w-full flex-col items-center justify-center bg-white px-8 text-center font-excalifont"
      style={{ fontFamily: EXCALIFONT_STACK }}
    >
      <p className="text-2xl font-bold tracking-tight text-gray-900 md:text-3xl lg:text-4xl">
        {introText}
      </p>
    </div>
  );

  if (embedded) {
    return (
      <div className="flex h-full w-full items-center justify-center p-3 md:p-5">
        <div className="h-full w-full max-w-3xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg">
          {inner}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-white p-6">
      <div className="aspect-[3/2] w-full max-w-3xl overflow-hidden rounded-2xl border border-gray-200 shadow-lg">
        {inner}
      </div>
    </div>
  );
}

export function MarkYourAnswersScreen({
  embedded = false,
  secondsLeft = 3,
  holdSeconds = 3,
  markText = QUESTION_MARK_SCREEN_TEXT_DEFAULT,
}: {
  embedded?: boolean;
  secondsLeft?: number;
  holdSeconds?: number;
  markText?: string;
}) {
  const shown = Math.max(0, secondsLeft);
  const inner = (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-6 bg-white px-8 text-center font-excalifont"
      style={{ fontFamily: EXCALIFONT_STACK }}
    >
      <p className="text-2xl font-bold tracking-tight text-gray-900 md:text-3xl lg:text-4xl">
        {markText}
      </p>
      <div className="relative flex h-28 w-28 items-center justify-center md:h-32 md:w-32">
        <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 120 120" aria-hidden>
          <circle cx="60" cy="60" r="52" fill="none" stroke="#e5e7eb" strokeWidth="8" />
          <circle
            cx="60"
            cy="60"
            r="52"
            fill="none"
            stroke="#2563eb"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${(shown / holdSeconds) * 326.7} 326.7`}
          />
        </svg>
        <span className="text-5xl font-bold tabular-nums text-blue-600 md:text-6xl">{shown}</span>
      </div>
      <p className="text-sm text-gray-500">{holdSeconds} second pause</p>
    </div>
  );

  if (embedded) {
    return (
      <div className="flex h-full w-full items-center justify-center p-3 md:p-5">
        <div className="h-full w-full max-w-3xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg">
          {inner}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-white p-6">
      <div className="aspect-[3/2] w-full max-w-3xl overflow-hidden rounded-2xl border border-gray-200 shadow-lg">
        {inner}
      </div>
    </div>
  );
}

export function QuestionScene({
  content,
  progress,
  embedded = false,
}: {
  content: QuestionSceneContent;
  progress: number;
  embedded?: boolean;
}) {
  const letters = ["A", "B", "C", "D"] as const;

  const card = (
    <div
      className="flex h-full w-full flex-col gap-5 overflow-y-auto bg-white px-6 py-6 font-excalifont md:gap-6 md:px-10 md:py-8"
      style={{ fontFamily: EXCALIFONT_STACK }}
    >
      <FadeIn progress={questionRevealProgress(progress, "question")}>
        <h2 className="text-xl font-bold leading-snug text-gray-900 md:text-2xl lg:text-3xl">
          {content.question}
        </h2>
      </FadeIn>

      <FadeIn
        progress={questionRevealProgress(progress, "hint")}
        className="flex items-center gap-2 text-sm text-gray-500 md:text-base"
      >
        <InfoIcon className="h-4 w-4 shrink-0" />
        <span>{QUESTION_HINT_LABELS[content.kind]}</span>
      </FadeIn>

      <div className="flex flex-col gap-3 md:gap-3.5">
        {letters.map((letter, i) => {
          const step = `option-${letter.toLowerCase()}` as "option-a" | "option-b" | "option-c" | "option-d";
          const p = questionRevealProgress(progress, step);
          return (
            <FadeIn key={letter} progress={p}>
              <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 md:gap-4 md:px-5 md:py-4">
                {content.kind === "mcq" ? (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-gray-300 bg-white" />
                ) : (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 border-gray-300 bg-white" />
                )}
                <span className="text-lg font-bold text-blue-600 md:text-xl">{letter}</span>
                <span className="text-base text-gray-800 md:text-lg">{content.options[i]}</span>
              </div>
            </FadeIn>
          );
        })}
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="flex h-full w-full items-center justify-center p-3 md:p-5">
        <div className="h-full w-full max-w-3xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg">
          {card}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-white p-6">
      <div className="aspect-[3/2] w-full max-w-3xl overflow-hidden rounded-2xl border border-gray-200 shadow-lg">
        {card}
      </div>
    </div>
  );
}
