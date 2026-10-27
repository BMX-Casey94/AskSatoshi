/**
 * Dictation via the Web Speech API — free and browser-native. Chromium (Chrome/Edge)
 * supports it; Firefox/Safari get a graceful "unsupported" path instead of a crash.
 */

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    isFinal: boolean;
    0: { transcript: string };
  }[];
}

interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
}

export interface Recogniser {
  supported: boolean;
  listening: boolean;
  start: (handlers: {
    onInterim: (text: string) => void;
    onFinal: (text: string) => void;
    onEnd: () => void;
    onError: (reason: string) => void;
  }) => void;
  stop: () => void;
}

const MAX_AUTO_RESTARTS = 5;

export function createRecogniser(): Recogniser {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;

  if (!Ctor) {
    return {
      supported: false,
      listening: false,
      start: () => undefined,
      stop: () => undefined,
    };
  }

  const rec = new Ctor();
  rec.lang = 'en-GB';
  rec.continuous = true;
  rec.interimResults = true;

  let wantListening = false;
  /** Text from earlier recogniser sessions in this dictation (engines end sessions on silence). */
  let committed = '';
  let current = '';
  let restarts = 0;

  const join = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);

  const self: Recogniser = {
    supported: true,
    listening: false,
    start({ onInterim, onEnd, onError }) {
      wantListening = true;
      committed = '';
      current = '';
      restarts = 0;
      let fatal = false;

      rec.onresult = (event) => {
        restarts = 0;
        // Rebuild the whole session transcript on every event. Appending from
        // resultIndex duplicates words on engines (notably Android Chrome) that
        // emit cumulative results ("hello", "hello world", ...) as separate entries.
        const segments: string[] = [];
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result?.[0]?.transcript?.trim();
          if (!text) continue;
          const prev = segments[segments.length - 1];
          if (prev && text.toLowerCase().startsWith(prev.toLowerCase())) {
            segments[segments.length - 1] = text; // cumulative repeat: replace
          } else if (prev && prev.toLowerCase().startsWith(text.toLowerCase())) {
            continue; // shorter echo of what we already have
          } else {
            segments.push(text);
          }
        }
        current = segments.join(' ');
        onInterim(join(committed, current));
      };
      rec.onerror = (event) => {
        const reason = event.error ?? 'unknown';
        // 'no-speech' and 'aborted' are routine; onend restarts if still wanted.
        if (reason === 'no-speech' || reason === 'aborted') return;
        fatal = true;
        wantListening = false;
        self.listening = false;
        onError(reason);
      };
      rec.onend = () => {
        // Browsers end a session after a pause. Carry on unless the user stopped it.
        if (wantListening && !fatal && restarts < MAX_AUTO_RESTARTS) {
          committed = join(committed, current);
          current = '';
          restarts += 1;
          try {
            rec.start();
            return;
          } catch {
            // fall through to a normal end
          }
        }
        wantListening = false;
        self.listening = false;
        onEnd();
      };
      try {
        rec.start();
        self.listening = true;
      } catch {
        wantListening = false;
        self.listening = false;
        onError('start-failed');
      }
    },
    stop() {
      wantListening = false;
      if (!self.listening) return;
      rec.stop();
      self.listening = false;
    },
  };
  return self;
}

type BrowserKind = 'opera' | 'brave' | 'other';

function detectBrowser(): BrowserKind {
  const nav = navigator as Navigator & { brave?: unknown };
  if (/\bOPR\/|\bOpera\b/.test(navigator.userAgent)) return 'opera';
  if (nav.brave) return 'brave';
  return 'other';
}

const UNSUPPORTED_ENGINE =
  'isn’t able to use the speech service dictation relies on. Please type your question, or try Chrome or Edge.';

/** A user-facing explanation for a dictation failure, tailored to the browser where we know the cause. */
export function describeSpeechError(reason: string): string {
  const browser = detectBrowser();
  switch (reason) {
    case 'not-allowed':
    case 'service-not-allowed':
      return browser === 'brave' || browser === 'opera'
        ? 'Dictation was blocked. Allow the microphone for this site, and check your browser’s privacy settings for speech services.'
        : 'Microphone access is blocked — allow it in your browser’s site settings.';
    case 'audio-capture':
      return 'No microphone found — connect one and try again.';
    case 'network':
      if (browser === 'opera') return `Opera ${UNSUPPORTED_ENGINE}`;
      if (browser === 'brave') return `Brave ${UNSUPPORTED_ENGINE}`;
      return 'Dictation could not reach the speech service. Check your connection and try again.';
    case 'language-not-supported':
      return 'Dictation does not support British English in this browser.';
    default:
      return 'Dictation cut out — check your microphone and try again.';
  }
}

/** Shown when dictation starts but no speech is ever transcribed (typical of Opera and Brave). */
export function describeSilentFailure(): string {
  const browser = detectBrowser();
  if (browser === 'opera') return `Opera ${UNSUPPORTED_ENGINE}`;
  if (browser === 'brave') return `Brave ${UNSUPPORTED_ENGINE}`;
  return 'No speech was picked up. Check your microphone is selected and try again.';
}
