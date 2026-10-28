/**
 * The chat screen: slim header (history, home, new chat, theme), the message
 * column, and the composer docked at the bottom with the sleep banner beneath it.
 */

import type { AttachedImage, Depth, Message } from '../types';
import { AiNotice } from './AiNotice';
import { Composer } from './Composer';
import { CorpusStamp } from './CorpusStamp';
import { MessageList } from './MessageList';
import { SleepBanner } from './SleepBanner';
import { ThemeToggle } from './ThemeToggle';
import { CloseIcon, DownloadIcon, HomeIcon, MenuIcon, PlusIcon } from './icons';

interface Props {
  messages: Message[];
  awaitingFirstToken: boolean;
  chatPhase: 'warming' | 'typing' | 'reviewing';
  sending: boolean;
  composerValue: string;
  onComposerChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onRetry: (failedAssistantId: string) => void;
  asleep: boolean;
  retryAfter?: string;
  sleepLines?: string[];
  listening: boolean;
  speechSupported: boolean;
  onMicToggle: () => void;
  image: AttachedImage | null;
  imagePending?: boolean;
  /** Session-only object URLs keyed by user message id. Never persisted. */
  userImageUrls?: Readonly<Record<string, string>>;
  onAttach: (file: File) => void;
  onRemoveImage: () => void;
  theme: 'light' | 'dark';
  onThemeToggle: () => void;
  onOpenHistory: () => void;
  onNewChat: () => void;
  onExport: () => void;
  showStorageNotice: boolean;
  onDismissStorageNotice: () => void;
  onRate: (id: string, rating: 'up' | 'down') => void;
  onAsk: (question: string) => void;
  depth: Depth;
  onDepthChange: (depth: Depth) => void;
  corpusUpdated?: string;
}

export function ChatView(props: Props) {
  return (
    <div className="chat">
      <header className="chat-header">
        <button type="button" className="icon-btn" onClick={props.onOpenHistory} aria-label="Open chat history">
          <MenuIcon size={18} />
        </button>
        <button
          type="button"
          className="icon-btn chat-home"
          onClick={props.onNewChat}
          aria-label="Back to home"
          title="Back to home"
        >
          <HomeIcon size={18} />
        </button>
        <div className="chat-header-actions">
          {props.messages.length > 0 && (
            <button
              type="button"
              className="icon-btn"
              onClick={props.onExport}
              aria-label="Export chat as Markdown"
              title="Export chat as Markdown"
            >
              <DownloadIcon size={18} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={props.onNewChat} aria-label="New chat" title="New chat">
            <PlusIcon size={18} />
          </button>
          <ThemeToggle theme={props.theme} onToggle={props.onThemeToggle} />
        </div>
      </header>
      <MessageList
        messages={props.messages}
        awaitingFirstToken={props.awaitingFirstToken}
        chatPhase={props.chatPhase}
        onRetry={props.onRetry}
        sending={props.sending}
        onRate={props.onRate}
        onAsk={props.onAsk}
        userImageUrls={props.userImageUrls}
      />
      <div className="chat-dock">
        {props.showStorageNotice && (
          <div className="storage-note" role="note">
            <span>
              Chats live only in this browser's local storage and may be cleared. Save anything you
              want to keep.
            </span>
            <button
              type="button"
              className="storage-note-close"
              onClick={props.onDismissStorageNotice}
              aria-label="Dismiss"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        )}
        <Composer
          value={props.composerValue}
          onChange={props.onComposerChange}
          onSubmit={props.onSubmit}
          onStop={props.onStop}
          disabled={false}
          asleep={props.asleep}
          sending={props.sending}
          listening={props.listening}
          speechSupported={props.speechSupported}
          onMicToggle={props.onMicToggle}
          image={props.image}
          imagePending={props.imagePending}
          onAttach={props.onAttach}
          onRemoveImage={props.onRemoveImage}
          onFocusChange={() => undefined}
          depth={props.depth}
          onDepthChange={props.onDepthChange}
        />
        {props.asleep && <SleepBanner retryAfter={props.retryAfter} lines={props.sleepLines} />}
        <AiNotice className="chat-footnote" />
        <CorpusStamp updated={props.corpusUpdated} />
      </div>
    </div>
  );
}
