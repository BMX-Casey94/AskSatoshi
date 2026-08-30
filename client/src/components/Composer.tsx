/**
 * The chat composer: rounded box with globe (grounding indicator) and attach on the
 * left, dictate + send on the right. Enter sends, Shift+Enter inserts a newline.
 */

import { useEffect, useRef } from 'react';
import type { AttachedImage } from '../types';
import { ArrowUpIcon, CloseIcon, GlobeIcon, MicIcon, PaperclipIcon, StopIcon } from './icons';

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
  onAttach: (file: File) => void;
  onRemoveImage: () => void;
  onFocusChange: (focused: boolean) => void;
  autoFocus?: boolean;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ACCEPTED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
/** Matches the server's MAX_QUESTION_CHARS. */
const MAX_CHARS = 8_000;
/** Only show the counter once the user is within this many chars of the cap. */
const COUNTER_THRESHOLD = 500;

export function Composer(props: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Auto-grow the textarea up to a cap, then scroll internally.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [props.value]);

  useEffect(() => {
    if (props.autoFocus && !props.disabled) textareaRef.current?.focus();
  }, [props.autoFocus, props.disabled]);

  const canSend =
    !props.disabled && !props.asleep && !props.sending && (props.value.trim().length > 0 || props.image !== null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) props.onSubmit();
    }
  };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPTED_MIMES.includes(file.type) || file.size > MAX_IMAGE_BYTES) {
      props.onAttach(new File([], 'rejected', { type: 'application/x-rejected' }));
      return;
    }
    props.onAttach(file);
  };

  return (
    <div className={`composer${props.asleep ? ' composer--asleep' : ''}`}>
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
        placeholder={props.asleep ? 'Satoshi is sleeping…' : 'Ask anything…'}
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
          <span
            className="icon-btn composer-globe"
            title="Grounded by the BSV knowledge MCP and Satoshi's own writings"
            aria-label="Grounded by the BSV knowledge MCP and Satoshi's own writings"
          >
            <GlobeIcon size={18} />
          </span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => fileRef.current?.click()}
            disabled={props.disabled || props.asleep || props.sending}
            aria-label="Attach an image"
            title="Attach an image (PNG, JPEG or WebP, up to 4 MB)"
          >
            <PaperclipIcon size={18} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(e) => {
              handleFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        <div className="composer-toolbar-right">
          {props.speechSupported && (
            <button
              type="button"
              className={`icon-btn${props.listening ? ' icon-btn--listening' : ''}`}
              onClick={props.onMicToggle}
              disabled={props.disabled || props.asleep || props.sending}
              aria-label={props.listening ? 'Stop dictation' : 'Dictate your question'}
              title={props.listening ? 'Stop dictation' : 'Dictate your question'}
            >
              <MicIcon size={18} />
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
  );
}
