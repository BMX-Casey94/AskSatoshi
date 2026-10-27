/**
 * Client-side image attach rules. The server rejects a blank question (BAD_INPUT)
 * and a base64 payload over 6,000,000 characters. A 4 MB file encodes to
 * 5,592,408 characters, which fits that cap but sits close to it, so anything
 * near the cap or larger than 1,600 px on the long edge is redrawn smaller
 * before it is sent. Base64 stays off the persisted thread.
 */

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Zod ceiling on `image.data` in the chat body. */
export const SERVER_BASE64_LIMIT = 6_000_000;
/**
 * Stay under the schema cap. 5,200,000 characters is about 3.72 MB of bytes,
 * so a file that would land in the last stretch before 6,000,000 is re-encoded.
 */
export const SAFE_BASE64_CHARS = 5_200_000;
export const MAX_IMAGE_EDGE = 1_600;

export const IMAGE_ONLY_PROMPT = 'What does this image show, and does it bear on Bitcoin?';

export const IMAGE_NOTICE_TYPE = 'PNG, JPEG or WebP only — that file will not attach.';
export const IMAGE_NOTICE_SIZE = 'That image is heavier than a full block — keep it under 4 MB.';
export const IMAGE_NOTICE_READ = 'That image could not be read. Try a smaller PNG, JPEG or WebP.';

export const ACCEPTED_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';

const EDGE_LADDER = [1_600, 1_280, 1_024, 800] as const;
const QUALITY_LADDER = [0.86, 0.72, 0.58] as const;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface EncodeStep {
  width: number;
  height: number;
  mimeType: ImageMime;
  quality?: number;
}

export interface PreparedImage {
  data: string;
  mimeType: ImageMime;
  blob: Blob;
}

export class ImageAttachError extends Error {
  readonly notice: string;

  constructor(notice: string) {
    super(notice);
    this.name = 'ImageAttachError';
    this.notice = notice;
  }
}

export function normaliseImageMime(type: string): ImageMime | null {
  const mime = type.toLowerCase().trim();
  if (mime === 'image/jpg' || mime === 'image/jpeg' || mime === 'image/pjpeg') return 'image/jpeg';
  if (mime === 'image/png' || mime === 'image/x-png') return 'image/png';
  if (mime === 'image/webp') return 'image/webp';
  return null;
}

/** Null when the file may be prepared. Otherwise a sentence for the notice. */
export function rejectionNotice(file: { type: string; size: number }): string | null {
  if (!normaliseImageMime(file.type)) return IMAGE_NOTICE_TYPE;
  if (!Number.isFinite(file.size) || file.size <= 0) return IMAGE_NOTICE_READ;
  if (file.size > MAX_IMAGE_BYTES) return IMAGE_NOTICE_SIZE;
  return null;
}

/** Standard base64 length of `bytes` raw bytes, without newlines. */
export function base64LengthForBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return 4 * Math.ceil(Math.floor(bytes) / 3);
}

/**
 * True when the file should be redrawn: the long edge is over 1,600 px, or the
 * base64 would sit in the margin under the server's 6,000,000-character cap.
 */
export function imageNeedsProcessing(width: number, height: number, byteLength: number): boolean {
  const w = Number.isFinite(width) ? width : 0;
  const h = Number.isFinite(height) ? height : 0;
  if (Math.max(w, h) > MAX_IMAGE_EDGE) return true;
  return base64LengthForBytes(byteLength) > SAFE_BASE64_CHARS;
}

/** Fit inside `maxEdge` on the long side. Never upscales. Never rounds past the cap. */
export function scaledImageSize(
  width: number,
  height: number,
  maxEdge: number = MAX_IMAGE_EDGE,
): { width: number; height: number } {
  const w = Math.round(Number.isFinite(width) ? width : 0);
  const h = Math.round(Number.isFinite(height) ? height : 0);
  const cap = Math.round(Number.isFinite(maxEdge) ? maxEdge : 0);
  if (w <= 0 || h <= 0 || cap <= 0) return { width: 0, height: 0 };
  if (Math.max(w, h) <= cap) return { width: w, height: h };
  if (w >= h) {
    return { width: cap, height: Math.max(1, Math.min(cap, Math.round((h * cap) / w))) };
  }
  return { width: Math.max(1, Math.min(cap, Math.round((w * cap) / h))), height: cap };
}

/**
 * Largest acceptable draw first, then smaller edges and lower quality.
 * Alpha keeps WebP (and a PNG fallback). Opaque images become JPEG on white.
 */
export function encodeSteps(width: number, height: number, hasAlpha: boolean): EncodeStep[] {
  const natural = scaledImageSize(width, height, Math.max(width, height));
  if (natural.width <= 0 || natural.height <= 0) return [];
  const long = Math.max(natural.width, natural.height);
  const edges: number[] = [];
  const add = (edge: number) => {
    if (edge > 0 && edge <= long && !edges.includes(edge)) edges.push(edge);
  };
  add(Math.min(MAX_IMAGE_EDGE, long));
  for (const edge of EDGE_LADDER) add(edge);

  const steps: EncodeStep[] = [];
  for (const edge of edges) {
    const size = scaledImageSize(natural.width, natural.height, edge);
    if (size.width <= 0 || size.height <= 0) continue;
    if (hasAlpha) {
      for (const quality of QUALITY_LADDER) steps.push({ ...size, mimeType: 'image/webp', quality });
      steps.push({ ...size, mimeType: 'image/png' });
    } else {
      for (const quality of QUALITY_LADDER) steps.push({ ...size, mimeType: 'image/jpeg', quality });
    }
  }
  return steps;
}

/** Strip a `data:*;base64,` prefix. Rejects anything the chat schema would refuse. */
export function stripDataUrlPrefix(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma).toLowerCase();
  if (!header.startsWith('data:') || !header.includes(';base64')) return null;
  const payload = dataUrl.slice(comma + 1).replace(/\s+/g, '');
  if (!payload || payload.length > SERVER_BASE64_LIMIT || !BASE64_RE.test(payload)) return null;
  return payload;
}

/** Question text for a send. An image with an empty box still needs a real question. */
export function messageTextForSend(raw: string, hasImage: boolean): string {
  const text = raw.trim();
  if (text.length > 0) return text;
  return hasImage ? IMAGE_ONLY_PROMPT : '';
}

/** Send is allowed for typed text or an attached image. Callers still apply asleep/sending. */
export function canComposeSend(text: string, hasImage: boolean): boolean {
  return hasImage || text.trim().length > 0;
}

export function attachmentLabel(name: string, max = 28): string {
  const trimmed = name.trim();
  if (!trimmed) return 'image';
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/** Prefer a real image from a drop list; otherwise the first file so it can be rejected out loud. */
export function preferredAttachFile<T extends { type: string }>(files: ArrayLike<T> | null | undefined): T | null {
  if (!files || files.length === 0) return null;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (file && normaliseImageMime(file.type)) return file;
  }
  return files[0] ?? null;
}

interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  close: () => void;
}

function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ImageAttachError(IMAGE_NOTICE_READ));
    img.src = url;
  });
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        width: bitmap.width,
        height: bitmap.height,
        source: bitmap,
        close: () => bitmap.close(),
      };
    } catch {
      throw new ImageAttachError(IMAGE_NOTICE_READ);
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await loadHtmlImage(url);
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      source: img,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Decode already happened. A second decode with resize bounds memory for huge pixel sizes. */
async function maybeResize(file: File, decoded: DecodedImage): Promise<DecodedImage> {
  if (Math.max(decoded.width, decoded.height) <= MAX_IMAGE_EDGE) return decoded;
  if (typeof createImageBitmap !== 'function') return decoded;
  const size = scaledImageSize(decoded.width, decoded.height, MAX_IMAGE_EDGE);
  if (size.width <= 0 || size.height <= 0) return decoded;
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      resizeWidth: size.width,
      resizeHeight: size.height,
      resizeQuality: 'high',
    });
    decoded.close();
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close(),
    };
  } catch {
    return decoded;
  }
}

async function sourceHasAlpha(image: DecodedImage): Promise<boolean> {
  const probe = scaledImageSize(image.width, image.height, 640);
  if (probe.width <= 0 || probe.height <= 0) return false;
  const canvas = document.createElement('canvas');
  canvas.width = probe.width;
  canvas.height = probe.height;
  const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
  // If we cannot inspect pixels, keep a format that can hold transparency.
  if (!ctx) return true;
  ctx.clearRect(0, 0, probe.width, probe.height);
  ctx.drawImage(image.source, 0, 0, probe.width, probe.height);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, probe.width, probe.height).data;
  } catch {
    return true;
  }
  for (let i = 3; i < data.length; i += 4) {
    const alpha = data[i];
    if (alpha !== undefined && alpha !== 255) return true;
  }
  return false;
}

function renderStep(source: CanvasImageSource, step: EncodeStep): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = step.width;
  canvas.height = step.height;
  const ctx = canvas.getContext('2d', { alpha: step.mimeType !== 'image/jpeg' });
  if (!ctx) return Promise.resolve(null);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (step.mimeType === 'image/jpeg') {
    // JPEG has no alpha. White matches a typical page better than the default black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, step.width, step.height);
  } else {
    ctx.clearRect(0, 0, step.width, step.height);
  }
  ctx.drawImage(source, 0, 0, step.width, step.height);
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), step.mimeType, step.quality);
  });
}

function blobToBase64(blob: Blob): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(typeof result === 'string' ? stripDataUrlPrefix(result) : null);
    };
    reader.onerror = () => reject(new ImageAttachError(IMAGE_NOTICE_READ));
    reader.readAsDataURL(blob);
  });
}

function fitsPayload(data: string, blob: Blob): boolean {
  return (
    data.length > 0 &&
    data.length <= SAFE_BASE64_CHARS &&
    data.length <= SERVER_BASE64_LIMIT &&
    blob.size > 0 &&
    blob.size <= MAX_IMAGE_BYTES &&
    base64LengthForBytes(blob.size) <= SAFE_BASE64_CHARS
  );
}

/**
 * Validate, and when the image is large, redraw it so the base64 stays under the
 * server cap. PNG and WebP transparency is kept; opaque images are JPEG.
 * The returned blob is what the preview object-URL should point at.
 */
export async function prepareImageFile(file: File): Promise<PreparedImage> {
  const rejection = rejectionNotice(file);
  if (rejection) throw new ImageAttachError(rejection);
  const sourceMime = normaliseImageMime(file.type);
  if (!sourceMime) throw new ImageAttachError(IMAGE_NOTICE_TYPE);

  let image = await decodeImage(file);
  try {
    if (image.width <= 0 || image.height <= 0) throw new ImageAttachError(IMAGE_NOTICE_READ);
    // Measure before resize. A successful resize shrinks the bitmap, but the file
    // on disk is still the original — that original must not be sent unchanged.
    const sourceWidth = image.width;
    const sourceHeight = image.height;
    image = await maybeResize(file, image);

    if (!imageNeedsProcessing(sourceWidth, sourceHeight, file.size)) {
      const original = await blobToBase64(file);
      if (original && fitsPayload(original, file)) {
        return { data: original, mimeType: sourceMime, blob: file };
      }
    }

    const hasAlpha = sourceMime !== 'image/jpeg' && (await sourceHasAlpha(image));
    const steps = encodeSteps(image.width, image.height, hasAlpha);
    if (steps.length === 0) throw new ImageAttachError(IMAGE_NOTICE_READ);

    for (const step of steps) {
      const blob = await renderStep(image.source, step);
      if (!blob) continue;
      const actual = normaliseImageMime(blob.type);
      // A JPEG result would flatten transparency we meant to keep.
      if (hasAlpha && actual === 'image/jpeg') continue;
      const mimeType = actual ?? step.mimeType;
      if (blob.size > MAX_IMAGE_BYTES || base64LengthForBytes(blob.size) > SAFE_BASE64_CHARS) continue;
      const data = await blobToBase64(blob);
      if (!data || !fitsPayload(data, blob)) continue;
      return { data, mimeType, blob };
    }

    throw new ImageAttachError(IMAGE_NOTICE_SIZE);
  } finally {
    image.close();
  }
}
