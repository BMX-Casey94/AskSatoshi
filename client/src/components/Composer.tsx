/**
 * The chat composer: attach and answer-depth on the left, dictate and send on the right.
 * Enter sends, Shift+Enter inserts a newline. An image can be picked, dropped, or pasted.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ACCEPTED_IMAGE_ACCEPT,
  canComposeSend,
  normaliseImageMime,
  preferredAttachFile,
} from '../lib/imageAttach';
import type { AttachedImage, Depth } from '../types';
import '../features.css';
import { DepthSelect } from './DepthSelect';
import { ArrowUpIcon, CloseIcon, MicIcon, PaperclipIcon, StopIcon } from './icons';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  disabled: boolean;
  asleep: boolean;
  sending: boolean;
  listening: boolean;
  speechSupported: boolean;
  onMicToggle: () => void;
  image: AttachedImage | null;
  /** True while a chosen file is still being read or scaled. Send waits so the image is included. */
  imagePending?: boolean;
  onAttach: (file: File) => void;
  onRemoveImage: () => void;
  onFocusChange: (focused: boolean) => void;
  depth: Depth;
  onDepthChange: (depth: Depth) => void;
  autoFocus?: boolean;
}

/** Matches the server's MAX_QUESTION_CHARS. */
const MAX_CHARS = 8_000;
/** Only show the counter once the user is within this many chars of the cap. */
const COUNTER_THRESHOLD = 500;

export function Composer(props: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Auto-grow the textarea up to a cap, then scroll internally.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [props.value]);

  // Keep the newest dictated words in view.
  useEffect(() => {
    const el = textareaRef.current;
    if (el && props.listening) el.scrollTop = el.scrollHeight;
  }, [props.value, props.listening]);

  useEffect(() => {
    if (props.autoFocus && !props.disabled) textareaRef.current?.focus();
  }, [props.autoFocus, props.disabled]);

  const canAttach = !props.disabled && !props.asleep && !props.sending;
  const canSend =
    canAttach && !props.imagePending && canComposeSend(props.value, props.image !== null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) props.onSubmit();
    }
  };

  const takeFile = (file: File | null) => {
    if (!file || !canAttach) return;
    props.onAttach(file);
  };

  return (
    <div className="composer-wrap">
      <div
        className={`composer${props.listening ? ' composer--listening' : ''}${props.asleep ? ' composer--asleep' : ''}${dragOver ? ' composer--drop' : ''}`}
        onDragEnter={(event) => {
          if (!canAttach || !hasFiles(event.dataTransfer)) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(event) => {
          if (!canAttach || !hasFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setDragOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          if (!canAttach) return;
          const image = imageFileFromTransfer(event.dataTransfer);
          takeFile(image ?? event.dataTransfer.files.item(0));
        }}
        onPaste={(event) => {
          if (!canAttach) return;
          const image = imageFileFromTransfer(event.clipboardData);
          if (!image) return;
          event.preventDefault();
          props.onAttach(image);
        }}
      >
      {props.image && (
        <div className="composer-attachment">
          <img src={props.image.previewUrl} alt="Attached" className="composer-attachment-img" />
          <span className="composer-attachment-name">{props.image.name}</span>
          <button
            type="button"
            className="icon-btn composer-attachment-remove"
            onClick={props.onRemoveImage}
            aria-label="Remove image"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="composer-input"
        rows={1}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => props.onFocusChange(true)}
        onBlur={() => props.onFocusChange(false)}
        placeholder={
          props.asleep
            ? 'Satoshi is sleeping…'
            : props.listening
              ? 'Listening… start speaking'
              : 'Ask anything…'
        }
        disabled={props.disabled || props.asleep}
        aria-label="Ask Satoshi a question"
        maxLength={MAX_CHARS}
      />
      {props.value.length >= MAX_CHARS - COUNTER_THRESHOLD && (
        <span
          className={`composer-charcount${props.value.length >= MAX_CHARS ? ' composer-charcount--max' : ''}`}
          aria-live="polite"
        >
          {props.value.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
        </span>
      )}
      <div className="composer-toolbar">
        <div className="composer-toolbar-left">
          <button
            type="button"
            className="icon-btn"
            onClick={() => fileRef.current?.click()}
            disabled={!canAttach}
            aria-busy={props.imagePending || undefined}
            aria-label="Attach an image"
            title="Attach an image (PNG, JPEG or WebP, up to 4 MB)"
          >
            <PaperclipIcon size={18} />
          </button>
          <input
            ref={fileRef}
            className="composer-file"
            type="file"
            accept={ACCEPTED_IMAGE_ACCEPT}
            hidden
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.item(0) ?? null;
              e.target.value = '';
              takeFile(file);
            }}
          />
          <DepthSelect value={props.depth} onChange={props.onDepthChange} />
        </div>
        <div className="composer-toolbar-right">
          {props.speechSupported && (
            <button
              type="button"
              className={`icon-btn${props.listening ? ' icon-btn--listening' : ''}`}
              onClick={props.onMicToggle}
              disabled={props.disabled || props.asleep || props.sending}
              aria-pressed={props.listening}
              aria-label={props.listening ? 'Stop dictation' : 'Dictate your question'}
              title={props.listening ? 'Stop dictation' : 'Dictate your question'}
            >
              <MicIcon size={18} />
              {props.listening && <span className="mic-label">Listening</span>}
            </button>
          )}
          {props.sending ? (
            <button
              type="button"
              className="send-btn"
              onClick={props.onStop}
              aria-label="Stop generating"
              title="Stop generating"
            >
              <StopIcon size={16} />
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              onClick={props.onSubmit}
              disabled={!canSend}
              aria-label="Send message"
              title="Send message"
            >
              <ArrowUpIcon size={18} />
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function hasFiles(data: DataTransfer | null): boolean {
  if (!data) return false;
  return Array.from(data.types).includes('Files');
}

/** An image from a drop or paste. Non-images are left for the caller to reject or ignore. */
function imageFileFromTransfer(data: DataTransfer | null): File | null {
  if (!data) return null;
  const fromList = preferredAttachFile(data.files);
  if (fromList && normaliseImageMime(fromList.type)) return fromList;
  const items = data.items;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (normaliseImageMime(file.type) || normaliseImageMime(item.type)) return file;
  }
  return null;
}
