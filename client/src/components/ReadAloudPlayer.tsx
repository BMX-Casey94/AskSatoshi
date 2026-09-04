/**
 * Themed read-aloud transport. The native <audio> element stays hidden and
 * does the actual playback; chrome (play/pause, seek, download) uses app tokens.
 */

import { useEffect, useId, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { formatPlaybackClock, TTS_DOWNLOAD_FILENAME, ttsDownloadUrl } from '../lib/ttsPlayer';
import { DownloadIcon, PauseIcon, PlayIcon } from './icons';

interface Props {
  src: string;
}

export function ReadAloudPlayer({ src }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const seekId = useId();
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);
  const seekingRef = useRef(false);
  const downloadHref = ttsDownloadUrl(src);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    setFailed(false);
    setPlaying(false);
    setCurrent(0);
    setDuration(Number.isFinite(el.duration) ? el.duration : 0);
    seekingRef.current = false;

    const syncTimes = () => {
      if (Number.isFinite(el.duration)) setDuration(el.duration);
      if (!seekingRef.current) setCurrent(el.currentTime);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrent(Number.isFinite(el.duration) ? el.duration : el.currentTime);
    };
    const onError = () => {
      setFailed(true);
      setPlaying(false);
    };

    el.addEventListener('timeupdate', syncTimes);
    el.addEventListener('durationchange', syncTimes);
    el.addEventListener('loadedmetadata', syncTimes);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);

    void el.play().catch(() => {
      setPlaying(false);
    });

    return () => {
      el.pause();
      el.removeEventListener('timeupdate', syncTimes);
      el.removeEventListener('durationchange', syncTimes);
      el.removeEventListener('loadedmetadata', syncTimes);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
    };
  }, [src]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el || failed) return;
    if (el.paused) {
      void el.play().catch(() => setPlaying(false));
    } else {
      el.pause();
    }
  };

  const onSeek = (event: ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    const next = Number(event.target.value);
    if (!el || !Number.isFinite(next)) return;
    seekingRef.current = true;
    el.currentTime = next;
    setCurrent(next);
  };

  const endSeek = () => {
    seekingRef.current = false;
  };

  const progress = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const seekMax = duration > 0 ? duration : 0;
  const seekValue = Math.min(current, seekMax);

  return (
    <div
      className="read-aloud-player"
      data-playing={playing ? 'true' : 'false'}
      style={{ '--seek-pct': `${progress}%` } as CSSProperties}
    >
      <audio ref={audioRef} className="read-aloud-audio" src={src} preload="auto" autoPlay />
      <button
        type="button"
        className="icon-btn read-aloud-transport"
        onClick={toggle}
        disabled={failed}
        aria-label={playing ? 'Pause reading' : 'Play reading'}
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
      </button>
      <span className="read-aloud-time" aria-hidden="true">
        {formatPlaybackClock(current)}
      </span>
      <input
        id={seekId}
        className="read-aloud-seek"
        type="range"
        min={0}
        max={seekMax}
        step={0.1}
        value={seekValue}
        onChange={onSeek}
        onPointerDown={() => {
          seekingRef.current = true;
        }}
        onPointerUp={endSeek}
        onPointerCancel={endSeek}
        onBlur={endSeek}
        disabled={failed || duration <= 0}
        aria-label="Seek"
        aria-valuetext={`${formatPlaybackClock(current)} of ${formatPlaybackClock(duration)}`}
      />
      <span className="read-aloud-time read-aloud-time--end" aria-hidden="true">
        {formatPlaybackClock(duration)}
      </span>
      {downloadHref && (
        <a
          className="icon-btn read-aloud-download"
          href={downloadHref}
          download={TTS_DOWNLOAD_FILENAME}
          aria-label="Download this reading"
          title="Download"
        >
          <DownloadIcon size={14} />
        </a>
      )}
      {failed && (
        <p className="read-aloud-player-error" role="alert">
          Could not play this audio.
        </p>
      )}
    </div>
  );
}
