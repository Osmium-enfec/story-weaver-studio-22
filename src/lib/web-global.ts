/**
 * Browser APIs used by export/audio. Node ESM has no lexical `window`,
 * even if hybrid export sets `globalThis.window`.
 */
type Webish = typeof globalThis & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
  OfflineAudioContext?: typeof OfflineAudioContext;
};

export function webGlobal(): Webish {
  return globalThis as Webish;
}

export function getAudioContextCtor(): typeof AudioContext | undefined {
  const g = webGlobal();
  return g.AudioContext || g.webkitAudioContext;
}

export function getOfflineAudioContextCtor(): typeof OfflineAudioContext | undefined {
  return webGlobal().OfflineAudioContext;
}
