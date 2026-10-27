import { describe, expect, it } from 'vitest';
import {
  IMAGE_NOTICE_READ,
  IMAGE_NOTICE_SIZE,
  IMAGE_NOTICE_TYPE,
  IMAGE_ONLY_PROMPT,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  SAFE_BASE64_CHARS,
  SERVER_BASE64_LIMIT,
  attachmentLabel,
  base64LengthForBytes,
  canComposeSend,
  encodeSteps,
  imageNeedsProcessing,
  messageTextForSend,
  normaliseImageMime,
  preferredAttachFile,
  rejectionNotice,
  scaledImageSize,
  stripDataUrlPrefix,
} from './imageAttach';

describe('base64LengthForBytes', () => {
  it('keeps a 4 MB file under the 6,000,000 character cap, close to the edge', () => {
    const chars = base64LengthForBytes(MAX_IMAGE_BYTES);
    expect(chars).toBe(5_592_408);
    expect(chars).toBeLessThan(SERVER_BASE64_LIMIT);
    expect(chars).toBeGreaterThan(SAFE_BASE64_CHARS);
    expect(SERVER_BASE64_LIMIT - chars).toBeLessThan(500_000);
  });

  it('treats empty or non-finite sizes as no payload', () => {
    expect(base64LengthForBytes(0)).toBe(0);
    expect(base64LengthForBytes(-10)).toBe(0);
    expect(base64LengthForBytes(Number.NaN)).toBe(0);
    expect(base64LengthForBytes(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('scaledImageSize', () => {
  it('caps the long edge at 1,600 px and preserves aspect', () => {
    expect(scaledImageSize(3200, 1800)).toEqual({ width: 1600, height: 900 });
    expect(scaledImageSize(2400, 800)).toEqual({ width: 1600, height: 533 });
    expect(scaledImageSize(800, 2400)).toEqual({ width: 533, height: 1600 });
    expect(scaledImageSize(4000, 2000)).toEqual({ width: 1600, height: 800 });
    expect(scaledImageSize(2000, 4000)).toEqual({ width: 800, height: 1600 });
  });

  it('leaves an image that already fits unchanged', () => {
    expect(scaledImageSize(1600, 900)).toEqual({ width: 1600, height: 900 });
    expect(scaledImageSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(scaledImageSize(1, 1)).toEqual({ width: 1, height: 1 });
  });

  it('never rounds past the cap, including a very thin frame', () => {
    const samples: Array<[number, number]> = [
      [1601, 1600],
      [999, 1000],
      [3, 2],
      [5000, 1],
      [1, 5000],
      [3333, 3333],
      [1000, 1001],
    ];
    for (const [w, h] of samples) {
      const size = scaledImageSize(w, h, MAX_IMAGE_EDGE);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    }
    expect(scaledImageSize(5000, 1)).toEqual({ width: 1600, height: 1 });
    expect(scaledImageSize(1, 5000)).toEqual({ width: 1, height: 1600 });
  });

  it('returns an empty size for a missing dimension', () => {
    expect(scaledImageSize(0, 100)).toEqual({ width: 0, height: 0 });
    expect(scaledImageSize(100, 0)).toEqual({ width: 0, height: 0 });
    expect(scaledImageSize(Number.NaN, 400)).toEqual({ width: 0, height: 0 });
    expect(scaledImageSize(-20, 400)).toEqual({ width: 0, height: 0 });
  });
});

describe('imageNeedsProcessing', () => {
  it('redraws a long edge over 1,600 px even when the file is small', () => {
    expect(imageNeedsProcessing(4000, 3000, 200_000)).toBe(true);
    expect(imageNeedsProcessing(1600, 1200, 200_000)).toBe(false);
    expect(imageNeedsProcessing(1599, 1599, 200_000)).toBe(false);
  });

  it('redraws a near-cap file even when the pixels already fit', () => {
    expect(imageNeedsProcessing(1200, 800, MAX_IMAGE_BYTES)).toBe(true);
    expect(imageNeedsProcessing(800, 600, 200_000)).toBe(false);
  });
});

describe('encodeSteps', () => {
  it('starts at 1,600 px JPEG for an opaque photo and then steps down', () => {
    const steps = encodeSteps(4000, 2000, false);
    expect(steps[0]).toEqual({ width: 1600, height: 800, mimeType: 'image/jpeg', quality: 0.86 });
    expect(steps.every((step) => step.mimeType === 'image/jpeg')).toBe(true);
    expect(steps.every((step) => Math.max(step.width, step.height) <= MAX_IMAGE_EDGE)).toBe(true);
    expect(steps.some((step) => step.width === 1280)).toBe(true);
    expect(steps.some((step) => step.quality === 0.58)).toBe(true);
  });

  it('uses WebP then PNG for transparency, never JPEG', () => {
    const steps = encodeSteps(2000, 1000, true);
    expect(steps[0]).toEqual({ width: 1600, height: 800, mimeType: 'image/webp', quality: 0.86 });
    expect(steps.find((step) => step.mimeType === 'image/png')).toMatchObject({ width: 1600, height: 800 });
    expect(steps.some((step) => step.mimeType === 'image/jpeg')).toBe(false);
  });

  it('does not upscale a picture that is already small', () => {
    const steps = encodeSteps(640, 480, false);
    expect(steps).toHaveLength(3);
    expect(steps.every((step) => step.width === 640 && step.height === 480)).toBe(true);
  });

  it('returns no steps when the source has no pixels', () => {
    expect(encodeSteps(0, 10, false)).toEqual([]);
    expect(encodeSteps(10, Number.NaN, true)).toEqual([]);
  });
});

describe('messageTextForSend', () => {
  it('fills a real question when the only input is an image', () => {
    expect(canComposeSend('', true)).toBe(true);
    expect(canComposeSend('   ', true)).toBe(true);
    expect(canComposeSend('', false)).toBe(false);
    expect(canComposeSend('  hello ', false)).toBe(true);

    const text = messageTextForSend('   ', true);
    expect(text).toBe(IMAGE_ONLY_PROMPT);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(messageTextForSend('  What is a nonce?  ', true)).toBe('What is a nonce?');
    expect(messageTextForSend('', false)).toBe('');
    expect(messageTextForSend('   ', false)).toBe('');
  });
});

describe('stripDataUrlPrefix', () => {
  it('keeps only the base64 payload', () => {
    expect(stripDataUrlPrefix('data:image/png;base64,aGk=')).toBe('aGk=');
    expect(stripDataUrlPrefix('data:image/jpeg;base64,aGk=\n')).toBe('aGk=');
    expect(stripDataUrlPrefix('data:image/webp;charset=utf-8;base64,abc+/=')).toBe('abc+/=');
  });

  it('rejects a raw payload, a bad alphabet, and a missing comma', () => {
    expect(stripDataUrlPrefix('aGk=')).toBeNull();
    expect(stripDataUrlPrefix('data:image/png;base64,****')).toBeNull();
    expect(stripDataUrlPrefix('data:image/png,aGk=')).toBeNull();
    expect(stripDataUrlPrefix('')).toBeNull();
  });
});

describe('rejectionNotice', () => {
  it('names the reason a file cannot be attached', () => {
    expect(rejectionNotice({ type: 'image/gif', size: 100 })).toBe(IMAGE_NOTICE_TYPE);
    expect(rejectionNotice({ type: 'image/jpeg', size: MAX_IMAGE_BYTES + 1 })).toBe(IMAGE_NOTICE_SIZE);
    expect(rejectionNotice({ type: 'image/png', size: 0 })).toBe(IMAGE_NOTICE_READ);
    expect(rejectionNotice({ type: 'image/webp', size: 2_000 })).toBeNull();
    expect(normaliseImageMime('image/jpg')).toBe('image/jpeg');
    expect(normaliseImageMime('IMAGE/PNG')).toBe('image/png');
    expect(normaliseImageMime('image/gif')).toBeNull();
  });
});

describe('preferredAttachFile', () => {
  it('picks the first real image, or the first file so a bad drop can be reported', () => {
    expect(preferredAttachFile(null)).toBeNull();
    expect(preferredAttachFile([])).toBeNull();
    expect(
      preferredAttachFile([
        { type: 'text/plain', name: 'notes.txt' },
        { type: 'image/png', name: 'shot.png' },
      ])?.name,
    ).toBe('shot.png');
    expect(preferredAttachFile([{ type: 'application/pdf', name: 'a.pdf' }])?.name).toBe('a.pdf');
  });
});

describe('attachmentLabel', () => {
  it('keeps a short name and clips a long one', () => {
    expect(attachmentLabel('')).toBe('image');
    expect(attachmentLabel('  block.png  ')).toBe('block.png');
    expect(attachmentLabel('a-very-long-screenshot-name.png')).toBe('a-very-long-screenshot-name.…');
    expect(attachmentLabel('a-very-long-screenshot-name.png').length).toBe(29);
  });
});
