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
});
