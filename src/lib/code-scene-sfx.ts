/** Keyboard typing loop for code scenes (typing variant). */
export const CODE_TYPING_SFX = "/sfx/typing-keyboard.mp3";

export function typingVisibleChars(code: string, progress: number): number {
  const total = code.length;
  return Math.floor(total * Math.min(1, progress * 1.15));
}

export function isTypingInProgress(code: string, progress: number): boolean {
  return code.length > 0 && typingVisibleChars(code, progress) < code.length && progress < 1;
}

/** Progress (0..1) along speech where typing animation and SFX end. */
export function typingSpeechEndProgress(code: string): number {
  if (!code.length || !isTypingInProgress(code, 0)) return 0;
  let lo = 0;
  let hi = 1;
  while (hi - lo > 0.0005) {
    const mid = (lo + hi) / 2;
    if (isTypingInProgress(code, mid)) lo = mid;
    else hi = mid;
  }
  return hi;
}
