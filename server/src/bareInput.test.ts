import { describe, expect, it } from 'vitest';
import {
  bareInputClarification,
  hasRelevantGrounding,
  isBareOffTopicShape,
  isRecognisedBitcoinFragment,
} from './bareInput.js';
import type { Grounding } from './orchestrate.js';

const NONE: Grounding = { mode: 'none', evidenceText: '', citations: [] };

const METAPHOR =
  /larger blocks|starter culture|rent-extracting|intermediar|integrity of the ledger|scaling thesis/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

describe('bare off-topic inputs', () => {
  it('answers "Sourdough" with a short clarification and no Bitcoin lesson', () => {
    const reply = bareInputClarification('Sourdough', NONE);
    expect(reply).toBeTruthy();
    expect(reply).toMatch(/Sourdough/);
    expect(reply).toMatch(/\?/);
    expect(sentences(reply!)).toHaveLength(2);
    expect(reply!.length).toBeLessThan(240);
    expect(reply).not.toMatch(METAPHOR);
    expect(bareInputClarification('Sourdough', NONE)).toBe(reply);
  });

  it('clarifies other bare nouns and pings that the record does not title-match', () => {
    for (const word of ['Pizza', 'test', 'Sourdough.', 'sourdough bread recipe']) {
      const reply = bareInputClarification(word, NONE);
      expect(reply, word).toBeTruthy();
      expect(reply).toMatch(/\?/);
      expect(sentences(reply!)).toHaveLength(2);
      expect(reply).not.toMatch(METAPHOR);
    }
  });

  it('rotates the wording across different subjects', () => {
    const replies = ['Sourdough', 'Pizza', 'violin', 'marble', 'quartz', 'kayak', 'linen'].map(
      (word) => bareInputClarification(word, NONE)!,
    );
    const skeletons = replies.map((reply) =>
      reply.replace(/sourdough|pizza|violin|marble|quartz|kayak|linen/gi, 'TOPIC'),
    );
    expect(new Set(skeletons).size).toBeGreaterThan(1);
  });

  it('does not catch short Bitcoin queries, even with no retrieved evidence', () => {
    for (const word of ['Bitcoin', 'blocks', 'Merkle trees', 'BRC-100', 'timecoin', 'UTXO', 'SPV', 'opcode', 'Script']) {
      expect(isRecognisedBitcoinFragment(word), word).toBe(true);
      expect(bareInputClarification(word, NONE), word).toBeNull();
    }
  });

  it('leaves greetings, questions, images, and follow-ups on the normal path', () => {
    expect(bareInputClarification('hello', NONE)).toBeNull();
    expect(bareInputClarification('ok', NONE)).toBeNull();
    expect(bareInputClarification('thanks', NONE)).toBeNull();
    expect(bareInputClarification('How do I bake sourdough bread?', NONE)).toBeNull();
    expect(bareInputClarification('What is Bitcoin?', NONE)).toBeNull();
    expect(bareInputClarification('Sourdough', NONE, { hasImage: true })).toBeNull();
    expect(bareInputClarification('Sourdough', NONE, { followUp: true })).toBeNull();
    expect(isBareOffTopicShape('one two three four')).toBe(false);
  });

  it('keeps a bare word when a citation title actually shares it', () => {
    const hit: Grounding = {
      mode: 'mcp',
      evidenceText: 'A note that names sourdough in the title only.',
      citations: [{ label: 'Sourdough note', title: 'Sourdough in the archive' }],
    };
    expect(hasRelevantGrounding('Sourdough', hit)).toBe(true);
    expect(bareInputClarification('Sourdough', hit)).toBeNull();
  });

  it('still clarifies when retrieved titles are about Bitcoin and not the word', () => {
    const miss: Grounding = {
      mode: 'mcp',
      evidenceText: 'Larger blocks and the integrity of the ledger.',
      citations: [{ label: 'Scaling', title: 'Unbounded on-chain scaling' }],
    };
    const reply = bareInputClarification('Sourdough', miss);
    expect(hasRelevantGrounding('Sourdough', miss)).toBe(false);
    expect(reply).toBeTruthy();
    expect(reply).not.toMatch(METAPHOR);
  });

  it('does not treat a title match on "test" as off-topic', () => {
    const tests: Grounding = {
      mode: 'mcp',
      evidenceText: 'TEST_KEYS is an exported constant.',
      citations: [{ label: 'TEST_KEYS', title: 'TEST_KEYS — exported const in runar-testing' }],
    };
    expect(bareInputClarification('test', tests)).toBeNull();
  });
});
