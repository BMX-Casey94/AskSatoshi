/**
 * All-quotas-spent state: witty rotating banner beneath the composer while the
 * composer and suggestions are disabled. Wakes itself via the status poller in App.
 */

import { useEffect, useState } from 'react';
import { MoonSleepIcon } from './icons';

const FALLBACK_LINES = [
  'Satoshi is currently sleeping — even the creator of Bitcoin needs his eight hours.',
  'Satoshi has grown tired of answering questions today. The difficulty adjusts; so must his diary.',
  'Satoshi has gone mining for the day. He resurfaces when the free quotas reset.',
];

interface Props {
  retryAfter?: string;
  lines?: string[];
}

export function SleepBanner({ retryAfter, lines }: Props) {
  const pool = lines && lines.length > 0 ? lines : FALLBACK_LINES;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % pool.length), 8_000);
    return () => window.clearInterval(timer);
  }, [pool.length]);

  const wake = retryAfter ? new Date(retryAfter) : null;
  const wakeLabel =
    wake && !Number.isNaN(wake.getTime())
      ? wake.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : null;

  return (
    <div className="sleep-banner" role="alert">
      <MoonSleepIcon size={18} />
      <div className="sleep-banner-text">
        <p className="sleep-banner-line">{pool[index]}</p>
        {wakeLabel && <p className="sleep-banner-wake">Back around {wakeLabel} your time.</p>}
      </div>
    </div>
  );
}
