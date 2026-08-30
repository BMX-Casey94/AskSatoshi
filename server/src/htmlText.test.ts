import { describe, expect, it } from 'vitest';
import { htmlToText, stripQuotedReplies } from './htmlText.js';

// The exact shape stored by the pinned archive for bitcointalk posts.
const ARCHIVE_POST =
  '<div class="post">Microsoft Security Essentials Live Protection is blocking your communication with the network.  &nbsp;<br/><br/>You need to make bitcoin.exe an excluded process in Live Protection.<br/><br/>The message &quot;Warning: This block was not received by any other nodes&quot; occurs when Bitcoin broadcasts a block.<br/></div>';

describe('htmlToText', () => {
  it('turns archive post HTML into clean prose with paragraph breaks', () => {
    const out = htmlToText(ARCHIVE_POST);
    expect(out).not.toMatch(/<[^>]*>/);
    expect(out).not.toMatch(/&[a-z#0-9]+;/i);
    expect(out).toContain(
      'Microsoft Security Essentials Live Protection is blocking your communication with the network.',
    );
    expect(out).toContain('\n\nYou need to make bitcoin.exe an excluded process');
    expect(out).toContain('"Warning: This block was not received by any other nodes"');
  });

  it('decodes named, decimal and hex entities', () => {
    expect(htmlToText('a &amp; b &lt; c &gt; d &#39;e&#x2019;f &nbsp;g')).toBe("a & b < c > d 'e’f  g");
  });

  it('decodes entities only after stripping, so &lt; can never re-form a tag', () => {
    const out = htmlToText('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toBe('<script>alert(1)</script>');
    // And a second pass must not treat those as tags (idempotent, safe to re-apply).
    expect(htmlToText(out)).toBe('<script>alert(1)</script>');
  });

  it('keeps list and code structure as line breaks', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('one\n\ntwo');
    expect(htmlToText('<div class="codeheader">Code:</div><div class="code">x = 1</div>')).toBe('Code:\n\nx = 1');
  });

  it('preserves angle-bracket fragments that are not forum tags', () => {
    // Decoded C++ includes must survive a second pass (ingest + cleanSlice both run).
    const once = htmlToText('&lt;stdio.h&gt; and &lt;stdlib.h&gt;');
    expect(once).toBe('<stdio.h> and <stdlib.h>');
    expect(htmlToText(once)).toBe(once);
  });

  it('is idempotent and leaves clean text untouched', () => {
    const clean = 'Plain prose, no markup. Line two.\n\nLine three.';
    expect(htmlToText(clean)).toBe(clean);
    expect(htmlToText(htmlToText(ARCHIVE_POST))).toBe(htmlToText(ARCHIVE_POST));
  });

  it('survives hostile numeric entities without throwing', () => {
    expect(() => htmlToText('boom &#99999999999; &#xFFFFFFFF;')).not.toThrow();
  });
});

// Real shape from the pinned archive (post in the "network split" thread): Satoshi's
// prose wraps two quote blocks, the first of which nests another user's quote AND the
// quoter's own commentary — all of it other people's words.
const POST_WITH_QUOTES =
  '<div class="post">creighto: I agree with that idea.  After a few hours, it should be possible for the client to notice if the flow of blocks has dropped off.<br/><br/>' +
  '<div class="quoteheader"><a href="https://bitcointalk.org/index.php?topic=661.msg7303#msg7303">Quote from: knightmb on August 03, 2010, 07:02:13 PM</a></div>' +
  '<div class="quote"><div class="quoteheader"><a href="https://bitcointalk.org/index.php?topic=661.msg7293#msg7293">Quote from: gavinandresen on August 03, 2010, 06:38:44 PM</a></div>' +
  '<div class="quote">Or if the split lasted long enough (more than 100 blocks), transactions that involve generated coins on the shorter chain would be invalid at the merge.<br/></div>' +
  'Interesting info, so other than some double-spending issues, as long as the block chain isn\'t separated for more than 100 or so blocks, <br/></div>' +
  'In practice, splits are likely to be very asymmetrical.  It would be hard to split the world down the middle.<br/><br/>' +
  '<div class="quoteheader"><a href="https://bitcointalk.org/index.php?topic=661.msg7303#msg7303">Quote from: knightmb on August 03, 2010, 07:02:13 PM</a></div>' +
  '<div class="quote">If there a hard coded limit on split delay?<br/></div>' +
  "There's no time limit.  Assuming you weren't spending coins generated in the minority fork, your transactions can get into the other chain at any time later.<br/><br/><br/></div>";

describe('stripQuotedReplies', () => {
  it('removes quoted users (nested quotes included) and keeps only Satoshi\u2019s prose', () => {
    const out = htmlToText(stripQuotedReplies(POST_WITH_QUOTES));
    // Satoshi's own paragraphs survive…
    expect(out).toContain('creighto: I agree with that idea.');
    expect(out).toContain('In practice, splits are likely to be very asymmetrical.');
    expect(out).toContain("There's no time limit.");
    // …whilst every other user's words — and the quoter's commentary — are gone.
    expect(out).not.toContain('Quote from');
    expect(out).not.toContain('Or if the split lasted long enough');
    expect(out).not.toContain('Interesting info');
    expect(out).not.toContain('hard coded limit on split delay');
  });

  it('keeps code blocks — Satoshi\u2019s code is his own voice', () => {
    const out = stripQuotedReplies('<div class="post">Try this:<div class="code">if (x) return;</div>Done.</div>');
    expect(out).toContain('if (x) return;');
    expect(out).toContain('Done.');
  });

  it('drops the tail of an unterminated quote rather than risking misattribution', () => {
    expect(stripQuotedReplies('<div class="post">His words.<div class="quote">quoted forever')).toBe(
      '<div class="post">His words.',
    );
  });

  it('leaves posts without quotes untouched', () => {
    const clean = '<div class="post">Just Satoshi here.<br/></div>';
    expect(stripQuotedReplies(clean)).toBe(clean);
  });
});
