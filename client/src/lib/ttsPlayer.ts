/**
 * Read-aloud player helpers with no fetch/window dependency so they can be
 * unit-tested from the server Vitest suite.
 */

export const TTS_DOWNLOAD_FILENAME = 'ask-satoshi-read-aloud.mp3';

function isTtsAudioUrl(url: string): boolean {
  return url.startsWith('/api/tts/audio/');
}

/** Same-origin playback URL plus `?download=1` so the server sends an attachment. */
export function ttsDownloadUrl(audioUrl: string): string | null {
  if (!isTtsAudioUrl(audioUrl)) return null;
  const qIndex = audioUrl.indexOf('?');
  const path = qIndex === -1 ? audioUrl : audioUrl.slice(0, qIndex);
  if (!isTtsAudioUrl(path)) return null;
  const query = qIndex === -1 ? '' : audioUrl.slice(qIndex + 1);
  const params = new URLSearchParams(query);
  params.set('download', '1');
  return `${path}?${params.toString()}`;
}

export function formatPlaybackClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}
