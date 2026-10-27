/** Small footer line for the corpus refresh date. Renders nothing when unknown. */

import { formatCorpusUpdated } from '../lib/corpusDate';

interface Props {
  updated?: string;
}

export function CorpusStamp({ updated }: Props) {
  if (!updated) return null;
  const formatted = formatCorpusUpdated(updated);
  if (!formatted) return null;
  return <p className="corpus-stamp">Sources last refreshed {formatted}</p>;
}
