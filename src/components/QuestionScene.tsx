import type { QuestionSceneContent } from "@/lib/question-scene-layout";
import { EXCALIFONT_STACK } from "@/lib/scene-font";
import {
  codingRevealProgress,
  QUESTION_HINT_LABELS,
  QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
  QUESTION_MARK_SCREEN_TEXT_DEFAULT,
  QUESTION_BG_GRADIENT_CSS,
  QUESTION_OPTION_ACCENT,
  questionOptionMode,
  questionRevealProgress,
  questionRevealStepsFor,
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
  const gradId = "mark-countdown-grad";
  const inner = (
    <div
      className="flex h-full w-full flex-col items-center justify-center bg-white px-8 text-center font-excalifont"
      style={{ fontFamily: EXCALIFONT_STACK }}
    >
      {/* Centered stack with extra space between title and circle */}
      <div className="flex -translate-y-3 flex-col items-center gap-12 md:gap-14">
        <p className="text-2xl font-bold tracking-tight text-gray-900 md:text-3xl lg:text-4xl">
          {markText}
        </p>
        <div className="relative flex h-28 w-28 items-center justify-center md:h-32 md:w-32">
          <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 120 120" aria-hidden>
            <defs>
              <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#ffb404" />
                <stop offset="50%" stopColor="#f67e00" />
                <stop offset="100%" stopColor="#e13900" />
              </linearGradient>
            </defs>
            <circle cx="60" cy="60" r="52" fill="none" stroke="#e5e7eb" strokeWidth="8" />
            <circle
              cx="60"
              cy="60"
              r="52"
              fill="none"
              stroke={`url(#${gradId})`}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${(shown / Math.max(1, holdSeconds)) * 326.7} 326.7`}
            />
          </svg>
          <span
            className="text-5xl font-bold tabular-nums md:text-6xl"
            style={{
              backgroundImage: QUESTION_BG_GRADIENT_CSS,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            {shown}
          </span>
        </div>
        <p className="text-sm text-gray-500">{holdSeconds} second pause</p>
      </div>
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

function CodingProblemScene({
  content,
  progress,
}: {
  content: QuestionSceneContent;
  progress: number;
}) {
  const tests = (content.codingTestCases ?? []).filter(
    (t) => t.input.trim() || t.output.trim(),
  );
  const activeTest = tests[0];
  const starter = content.codingStarterCode || "";
  const codeLines = starter.split("\n");

  return (
    <div className="flex h-full w-full overflow-hidden bg-[#f7f8fa] font-sans text-[11px] leading-snug text-gray-800 md:text-xs">
      <FadeIn
        progress={codingRevealProgress(progress, "problem")}
        className="flex h-full w-[42%] min-w-0 flex-col border-r border-gray-200 bg-white"
      >
        <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3 md:px-4 md:py-4">
          <h2 className="text-sm font-semibold text-gray-900 md:text-base">
            {content.codingTitle || content.subtitle || "Coding Problem"}
          </h2>
          {content.question.trim() && (
            <p className="whitespace-pre-wrap text-gray-700">{content.question}</p>
          )}
        </div>
      </FadeIn>

      <div className="flex h-full min-w-0 flex-1 flex-col">
        <FadeIn
          progress={codingRevealProgress(progress, "code")}
          className="flex min-h-0 flex-[1.35] flex-col border-b border-gray-200 bg-white"
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5">
            <span className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-700">
              Code
            </span>
            <span className="text-[10px] text-gray-400">Auto</span>
          </div>
          <div className="flex-1 overflow-auto bg-[#1e1e1e] px-0 py-2 font-mono text-[10px] leading-relaxed text-[#d4d4d4] md:text-[11px]">
            {codeLines.map((line, i) => (
              <div key={i} className="flex">
                <span className="w-8 shrink-0 select-none pr-2 text-right text-[#858585]">
                  {i + 1}
                </span>
                <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3">{line || " "}</pre>
              </div>
            ))}
          </div>
        </FadeIn>

        <FadeIn
          progress={codingRevealProgress(progress, "tests")}
          className="flex min-h-0 flex-1 flex-col bg-white"
        >
          <div className="flex items-center gap-3 border-b border-gray-100 px-3 py-1.5 text-[10px]">
            <span className="font-semibold text-gray-900">Testcase</span>
            <span className="text-gray-400">Test Result</span>
          </div>
          <div className="flex items-center gap-1.5 border-b border-gray-100 px-3 py-1.5">
            {(tests.length ? tests : [{ label: "Case 1", input: "", output: "" }]).map(
              (t, i) => (
                <span
                  key={i}
                  className={`rounded-md px-2 py-0.5 text-[10px] ${
                    i === 0 ? "bg-gray-100 font-medium text-gray-800" : "text-gray-500"
                  }`}
                >
                  {t.label || `Case ${i + 1}`}
                </span>
              ),
            )}
          </div>
          <div className="flex-1 space-y-2 overflow-auto px-3 py-2">
            {activeTest && (activeTest.input.trim() || activeTest.output.trim()) ? (
              <>
                {activeTest.input.trim() && (
                  <div className="space-y-0.5">
                    <p className="text-[10px] font-medium text-gray-500">Input =</p>
                    <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 font-mono text-[10px] whitespace-pre-wrap text-gray-800">
                      {activeTest.input}
                    </div>
                  </div>
                )}
                {activeTest.output.trim() && (
                  <div className="space-y-0.5">
                    <p className="text-[10px] font-medium text-gray-500">Output =</p>
                    <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 font-mono text-[10px] whitespace-pre-wrap text-gray-800">
                      {activeTest.output}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-[10px] text-gray-400">Add test case inputs…</p>
            )}
          </div>
        </FadeIn>
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
  if (content.kind === "coding") {
    const board = <CodingProblemScene content={content} progress={progress} />;
    if (embedded) {
      return (
        <div className="flex h-full w-full items-center justify-center p-2 md:p-3">
          <div className="h-full w-full max-w-5xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg">
            {board}
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full w-full items-center justify-center bg-white p-4">
        <div className="aspect-[3/2] w-full max-w-5xl overflow-hidden rounded-2xl border border-gray-200 shadow-lg">
          {board}
        </div>
      </div>
    );
  }

  const letters = ["A", "B", "C", "D"] as const;
  const revealSteps = questionRevealStepsFor(content.kind);
  const optionMode = questionOptionMode(content);
  const hintLabel =
    content.kind === "predictOutput"
      ? optionMode === "msq"
        ? "Select all that apply."
        : "Select one answer."
      : QUESTION_HINT_LABELS[content.kind];
  const codeLines = (content.predictCode ?? "").replace(/\r\n/g, "\n").split("\n");

  const card = (
    <div
      className="flex h-full w-full flex-col justify-center gap-4 overflow-y-auto bg-white px-6 py-6 font-excalifont md:gap-5 md:px-10 md:py-8"
      style={{ fontFamily: EXCALIFONT_STACK }}
    >
      <FadeIn progress={questionRevealProgress(progress, "question", revealSteps)}>
        <h2 className="text-xl font-bold leading-snug text-gray-900 md:text-2xl lg:text-3xl">
          {content.question}
        </h2>
      </FadeIn>

      {content.kind === "predictOutput" && (
        <FadeIn
          progress={questionRevealProgress(progress, "code", revealSteps)}
          className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
        >
          <div className="max-h-[28vh] overflow-auto px-0 py-2.5 font-mono text-[11px] leading-relaxed text-gray-800 md:text-xs">
            {codeLines.map((line, i) => (
              <div key={i} className="flex">
                <span className="w-8 shrink-0 select-none pr-2 text-right text-gray-400">
                  {i + 1}
                </span>
                <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3">
                  {line || " "}
                </pre>
              </div>
            ))}
          </div>
        </FadeIn>
      )}

      <FadeIn
        progress={questionRevealProgress(progress, "hint", revealSteps)}
        className="flex items-center gap-2 text-sm text-gray-500 md:text-base"
      >
        <InfoIcon className="h-4 w-4 shrink-0" />
        <span>{hintLabel}</span>
      </FadeIn>

      <div className="flex flex-col gap-3 md:gap-3.5">
        {letters.map((letter, i) => {
          const step = `option-${letter.toLowerCase()}`;
          const p = questionRevealProgress(progress, step, revealSteps);
          return (
            <FadeIn key={letter} progress={p}>
              <div
                className="rounded-xl p-[2px]"
                style={{ backgroundImage: QUESTION_BG_GRADIENT_CSS }}
              >
                <div className="flex items-center gap-3 rounded-[10px] bg-white px-4 py-3 md:gap-4 md:px-5 md:py-4">
                  {optionMode === "mcq" ? (
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 bg-white"
                      style={{ borderColor: QUESTION_OPTION_ACCENT }}
                    />
                  ) : (
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 bg-white"
                      style={{ borderColor: QUESTION_OPTION_ACCENT }}
                    />
                  )}
                  <span
                    className="text-lg font-bold md:text-xl"
                    style={{
                      backgroundImage: QUESTION_BG_GRADIENT_CSS,
                      WebkitBackgroundClip: "text",
                      backgroundClip: "text",
                      color: "transparent",
                    }}
                  >
                    {letter}
                  </span>
                  <span className="text-base text-gray-800 md:text-lg">
                    {content.options[i]}
                  </span>
                </div>
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
