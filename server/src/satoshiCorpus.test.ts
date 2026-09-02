import { describe, expect, it } from 'vitest';
import { SatoshiCorpus, type CorpusDoc } from './satoshiCorpus.js';

const DOCS: CorpusDoc[] = [
  {
    id: 'email-cryptography-2',
    kind: 'email',
    title: 'Bitcoin P2P e-cash paper',
    date: '2008-11-03T01:37:43Z',
    url: 'https://satoshi.nakamotoinstitute.org/emails/cryptography/2/',
    text: 'It would be safe for users to use Simplified Payment Verification (section 8) to check for double spending, which only requires having the chain of block headers, or about 12KB per day.',
  },
  {
    id: 'post-bitcointalk-287',
    kind: 'post',
    title: 'Re: Current Bitcoin economic model is unsustainable',
    date: '2010-02-21T05:44:24Z',
    url: 'https://satoshi.nakamotoinstitute.org/posts/bitcointalk/287/',
    text: 'In a few decades when the reward gets too small, the transaction fee will become the main compensation for nodes.',
  },
  {
    id: 'post-bitcointalk-195',
    kind: 'post',
    title: 'Re: Bitcoin does NOT violate Mises regression theorem',
    date: '2010-08-27T17:32:07Z',
    url: 'https://satoshi.nakamotoinstitute.org/posts/bitcointalk/195/',
    text: 'If there was nothing to use it for, it would have no value. Bitcoin is backed by its utility.',
  },
];

describe('SatoshiCorpus', () => {
  const corpus = new SatoshiCorpus(DOCS);

  it('finds the SPV email for an SPV question', () => {
    const hits = corpus.search('What is SPV (Simplified Payment Verification)?');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe('email-cryptography-2');
  });

  it('finds the fee post for a fee question', () => {
    const hits = corpus.search('Will transaction fees replace the block reward?');
    expect(hits[0]?.id).toBe('post-bitcointalk-287');
  });

  it('fails closed on unrelated gibberish', () => {
    expect(corpus.search('zxqwv plugh asdfgh')).toEqual([]);
  });

  it('strips archive HTML from documents at ingest', () => {
    const dirty = new SatoshiCorpus([
      {
        id: 'post-bitcointalk-186',
        kind: 'post',
        title: 'Re: Warning this block was not received by any other nodes',
        date: '2010-08-10T00:00:00Z',
        url: 'https://satoshi.nakamotoinstitute.org/posts/bitcointalk/186/',
        text: '<div class="post">You need to make bitcoin.exe an excluded process.&nbsp;<br/><br/>Your block will never become valid because nobody received it.<br/></div>',
      },
    ]);
    const hits = dirty.search('Why was my block not received by other nodes?');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).not.toMatch(/<[^>]*>/);
    expect(hits[0]?.text).toContain('Your block will never become valid because nobody received it.');
  });

  it('ranks the block-size-limit thread above stop-word distractors', () => {
    // Regression: "Was the block size always meant to be small?" used to rank
    // "Always pay transaction fee?" first — BM25 scored "was/the/always" as signal.
    const ranked = new SatoshiCorpus([
      {
        id: 'post-distractor',
        kind: 'post',
        title: 'Re: Always pay transaction fee?',
        date: '2010-07-01T00:00:00Z',
        url: 'https://satoshi.nakamotoinstitute.org/posts/bitcointalk/1/',
        text: 'You should always pay the fee. The block reward will not always be there, and the fee was always part of the design.',
      },
      {
        id: 'post-bitcointalk-485',
        kind: 'post',
        title: 'Re: [PATCH] increase block size limit',
        date: '2010-10-04T00:00:00Z',
        url: 'https://satoshi.nakamotoinstitute.org/posts/bitcointalk/485/',
        text: 'It can be phased in, like: if (blocknumber > 115000) maxblocksize = largerlimit. It can start being in versions way ahead, so by the time it reaches that block number and goes into effect, the older versions that do not have it are already obsolete.',
      },
    ]);
    const hits = ranked.search('Was the block size always meant to be small?');
    expect(hits[0]?.id).toBe('post-bitcointalk-485');
  });

  it('excludes other users\u2019 quoted replies from both the index and excerpts', () => {
    const withQuote = new SatoshiCorpus([
      {
        id: 'post-bitcointalk-661',
        kind: 'post',
        title: 'Re: What happens when network is split for prolonged time and reconnected?',
        date: '2010-08-03T00:00:00Z',
        url: 'https://satoshi.nakamotoinstitute.org/posts/bitcointalk/661/',
        text: '<div class="post">In practice, splits are likely to be very asymmetrical.<div class="quoteheader"><a href="https://bitcointalk.org/index.php?topic=661.msg7303#msg7303">Quote from: knightmb on August 03, 2010, 07:02:13 PM</a></div><div class="quote">If there a hard coded limit on split delay?<br/></div>There\u2019s no time limit.<br/></div>',
      },
    ]);
    // Satoshi's own words are indexed and returned…
    const hits = withQuote.search('Are network splits asymmetrical?');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain('asymmetrical');
    expect(hits[0]?.text).not.toContain('hard coded limit');
    // …but the quoted user's distinctive words are not indexed at all.
    expect(withQuote.search('knightmb coded delay')).toEqual([]);
  });
});

describe('SatoshiCorpus.searchAll (multi-query)', () => {
  const corpus = new SatoshiCorpus(DOCS);

  it('finds documents via a later variant when the first query misses', () => {
    const hits = corpus.searchAll(['zxqwv plugh asdfgh', 'Will transaction fees replace the block reward?']);
    expect(hits[0]?.id).toBe('post-bitcointalk-287');
  });

  it('dedupes documents across queries', () => {
    const hits = corpus.searchAll(['SPV', 'Simplified Payment Verification']);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.filter((h) => h.id === 'email-cryptography-2')).toHaveLength(1);
  });

  it('returns empty when every query misses', () => {
    expect(corpus.searchAll(['zxqwv plugh', 'asdfgh qwerty'])).toEqual([]);
  });

  it('respects the limit across the merged results', () => {
    const hits = corpus.searchAll(['Bitcoin', 'transaction'], 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('matches search() when given a single query', () => {
    const single = corpus.search('Will transaction fees replace the block reward?');
    const multi = corpus.searchAll(['Will transaction fees replace the block reward?']);
    expect(multi.map((h) => h.id)).toEqual(single.map((h) => h.id));
  });
});
