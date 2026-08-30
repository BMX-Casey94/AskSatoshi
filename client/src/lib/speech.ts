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

  const self: Recogniser = {
    supported: true,
    listening: false,
    start({ onInterim, onFinal, onEnd, onError }) {
      rec.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (!result) continue;
          if (result.isFinal) onFinal(result[0].transcript);
          else interim += result[0].transcript;
        }
        if (interim) onInterim(interim);
      };
      rec.onerror = (event) => {
        self.listening = false;
        onError(event.error ?? 'unknown');
      };
      rec.onend = () => {
        self.listening = false;
        onEnd();
      };
      try {
        rec.start();
        self.listening = true;
      } catch {
        self.listening = false;
        onError('start-failed');
      }
    },
    stop() {
      if (!self.listening) return;
      rec.stop();
      self.listening = false;
    },
  };
  return self;
}
