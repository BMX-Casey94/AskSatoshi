/** Footer line: corpus refresh date, then the Terms & Privacy link. */

import { Link } from '../lib/router';
import { formatCorpusUpdated } from '../lib/corpusDate';

interface Props {
  updated?: string;
}

export function CorpusStamp({ updated }: Props) {
  const formatted = updated ? formatCorpusUpdated(updated) : null;
  return (
    <p className="corpus-stamp">
      {formatted && (
        <>
          <span>Sources last refreshed {formatted}</span>
          <span className="corpus-stamp-sep" aria-hidden="true">
            ·
          </span>
        </>
      )}
      <Link href="/terms" className="corpus-stamp-link">
        Terms &amp; Privacy
      </Link>
    </p>
  );
}
