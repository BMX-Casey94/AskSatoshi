import { describe, expect, it } from 'vitest';
import { formatPlaybackClock, ttsDownloadUrl } from './ttsPlayer';

describe('formatPlaybackClock', () => {
  it('formats whole seconds as m:ss', () => {
    expect(formatPlaybackClock(0)).toBe('0:00');
    expect(formatPlaybackClock(5)).toBe('0:05');
    expect(formatPlaybackClock(65)).toBe('1:05');
  });

  it('treats invalid or negative values as 0:00', () => {
    expect(formatPlaybackClock(Number.NaN)).toBe('0:00');
    expect(formatPlaybackClock(-3)).toBe('0:00');
  });
});

describe('ttsDownloadUrl', () => {
  it('appends download=1 to a same-origin TTS audio path', () => {
    expect(ttsDownloadUrl('/api/tts/audio/p_abc')).toBe('/api/tts/audio/p_abc?download=1');
  });

  it('rejects addresses outside the TTS audio path', () => {
    expect(ttsDownloadUrl('https://evil.example/api/tts/audio/p_abc')).toBeNull();
    expect(ttsDownloadUrl('/api/other/p_abc')).toBeNull();
  });
});
