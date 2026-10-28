/**
 * Ask Satoshi — application shell. Owns threads (localStorage), theme, the
 * awake/asleep service status, dictation, image attachment and the SSE chat flow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatView } from './components/ChatView';
import { AiNotice } from './components/AiNotice';
import { Composer } from './components/Composer';
import { CorpusStamp } from './components/CorpusStamp';
import { Hero } from './components/Hero';
import { HistoryDrawer } from './components/HistoryDrawer';
import { SleepBanner } from './components/SleepBanner';
import { Suggestions } from './components/Suggestions';
import { ThemeToggle } from './components/ThemeToggle';
import { MenuIcon } from './components/icons';
import { getStatus, sendFeedback, streamChat } from './lib/api';
import { exportThreadMarkdown } from './lib/exportThread';
import {
  IMAGE_NOTICE_READ,
  ImageAttachError,
  attachmentLabel,
  messageTextForSend,
  prepareImageFile,
  rejectionNotice,
} from './lib/imageAttach';
import { Link } from './lib/router';
import { createRecogniser, describeSilentFailure, describeSpeechError } from './lib/speech';

/** How long dictation may stay silent before we assume the engine is not working. */
const SILENCE_TIMEOUT_MS = 10_000;
import { clearStore, isGroundingMode, loadDepth, loadStore, sanitizeFollowUps, saveDepth, saveStore } from './lib/storage';
import type { AttachedImage, AwakeState, Depth, Message, Thread } from './types';

function uid(): string {
  return crypto.randomUUID();
}

function threadTitle(firstQuestion: string): string {
  const t = firstQuestion.trim().replace(/\s+/g, ' ');
  return t.length > 56 ? `${t.slice(0, 56)}…` : t;
}

export function App() {
  const [store, setStore] = useState(loadStore);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => loadStore().theme ?? 'light');
  const [depth, setDepth] = useState<Depth>(loadDepth);
  const [corpusUpdated, setCorpusUpdated] = useState<string | undefined>();
  const [composer, setComposer] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [awaitingFirstToken, setAwaitingFirstToken] = useState(false);
  const [chatPhase, setChatPhase] = useState<'warming' | 'typing' | 'reviewing'>('typing');
  const [awakeState, setAwakeState] = useState<AwakeState>('awake');
  const [retryAfter, setRetryAfter] = useState<string | undefined>();
  const [sleepLines, setSleepLines] = useState<string[] | undefined>();
  const [image, setImage] = useState<AttachedImage | null>(null);
  const [imagePending, setImagePending] = useState(false);
  /** Object URLs for images sent this session. Not written to localStorage. */
  const [userImageUrls, setUserImageUrls] = useState<Record<string, string>>({});
  const [listening, setListening] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const attachSeq = useRef(0);
  const previewsRef = useRef<Record<string, string>>({});
  const feedbackSentRef = useRef<Set<string>>(new Set());
  const recogniser = useMemo(() => createRecogniser(), []);
  // Dictated text accumulates here so interim results replace rather than append.
  const dictatedBaseRef = useRef('');
  const silenceTimerRef = useRef<number | null>(null);

  const activeThread: Thread | null =
    store.threads.find((t) => t.id === store.activeThreadId) ?? null;
  const view: 'landing' | 'chat' = activeThread ? 'chat' : 'landing';
  const asleep = awakeState !== 'awake';

  // ---- persistence ---------------------------------------------------------

  useEffect(() => {
    saveStore({ ...store, theme });
  }, [store, theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // ---- service status (awake / asleep) --------------------------------------

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const st = await getStatus(signal);
      setAwakeState(st.state === 'unconfigured' ? 'asleep' : st.state);
      setRetryAfter(st.retryAfter);
      setSleepLines(st.sleepLines);
      setCorpusUpdated(typeof st.corpusUpdated === 'string' ? st.corpusUpdated : undefined);
    } catch {
      // A failed status check must never put the UI to sleep spuriously.
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshStatus(controller.signal);
    const interval = window.setInterval(() => void refreshStatus(), 60_000);
    const onFocus = () => void refreshStatus();
    window.addEventListener('focus', onFocus);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshStatus]);

  // ---- notices (image rejection, dictation unsupported…) ---------------------

  const flashNotice = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 4_000);
  };

  // ---- image attach -----------------------------------------------------------

  const rememberPreview = (id: string, url: string) => {
    const next = { ...previewsRef.current, [id]: url };
    previewsRef.current = next;
    setUserImageUrls(next);
  };

  const forgetPreviews = (ids: readonly string[]) => {
    if (ids.length === 0) return;
    const next = { ...previewsRef.current };
    let changed = false;
    for (const id of ids) {
      const url = next[id];
      if (!url) continue;
      URL.revokeObjectURL(url);
      delete next[id];
      changed = true;
    }
    if (!changed) return;
    previewsRef.current = next;
    setUserImageUrls(next);
  };

  const handleAttach = (file: File) => {
    const rejection = rejectionNotice(file);
    if (rejection) {
      flashNotice(rejection);
      return;
    }
    const seq = ++attachSeq.current;
    setImagePending(true);
    void prepareImageFile(file)
      .then((prepared) => {
        if (seq !== attachSeq.current) return;
        const previewUrl = URL.createObjectURL(prepared.blob);
        setImage((current) => {
          if (seq !== attachSeq.current) {
            URL.revokeObjectURL(previewUrl);
            return current;
          }
          if (current) URL.revokeObjectURL(current.previewUrl);
          return {
            data: prepared.data,
            mimeType: prepared.mimeType,
            previewUrl,
            name: attachmentLabel(file.name),
          };
        });
      })
      .catch((error: unknown) => {
        if (seq !== attachSeq.current) return;
        flashNotice(error instanceof ImageAttachError ? error.notice : IMAGE_NOTICE_READ);
      })
      .finally(() => {
        if (seq === attachSeq.current) setImagePending(false);
      });
  };

  const handleRemoveImage = () => {
    attachSeq.current += 1;
    setImagePending(false);
    if (image) URL.revokeObjectURL(image.previewUrl);
    setImage(null);
  };

  // ---- dictation ---------------------------------------------------------------

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const handleMicToggle = () => {
    if (!recogniser.supported) {
      flashNotice('Your browser cannot hear me — Chrome or Edge will do the trick.');
      return;
    }
    if (listening) {
      clearSilenceTimer();
      recogniser.stop();
      setListening(false);
      return;
    }
    dictatedBaseRef.current = composer;
    clearSilenceTimer();
    // Some engines (Opera, Brave) start without error but never transcribe anything.
    silenceTimerRef.current = window.setTimeout(() => {
      silenceTimerRef.current = null;
      recogniser.stop();
      setListening(false);
      flashNotice(describeSilentFailure());
    }, SILENCE_TIMEOUT_MS);
    recogniser.start({
      onInterim: (text) => {
        clearSilenceTimer();
        setComposer(joinDictation(dictatedBaseRef.current, text));
      },
      // speech.ts rebuilds the transcript on every result and does not call this.
      // The property stays because the recogniser type still requires it.
      onFinal: () => undefined,
      onEnd: () => {
        clearSilenceTimer();
        setListening(false);
      },
      onError: (reason) => {
        clearSilenceTimer();
        setListening(false);
        flashNotice(describeSpeechError(reason));
      },
    });
    setListening(true);
  };

  // ---- chat flow -----------------------------------------------------------------

  const updateActiveThread = (updater: (t: Thread) => Thread) => {
    setStore((s) => ({
      ...s,
      threads: s.threads.map((t) => (t.id === s.activeThreadId ? updater(t) : t)),
    }));
  };

  const send = (rawText?: string) => {
    // An image with an empty box still needs a real question, or the server rejects it.
    // The base64 stays on `sentImage` for this request only — never on the saved message.
    const text = messageTextForSend(rawText ?? composer, image !== null);
    if (!text || sending || asleep) return;
    // The send button is disabled while a file is still scaling. A suggestion
    // click in that moment should still ask its question.
    if (imagePending && rawText === undefined) return;
    if (listening) handleMicToggle();

    const userMessage: Message = { id: uid(), role: 'user', content: text, ts: Date.now() };
    const assistantMessage: Message = {
      id: uid(),
      role: 'assistant',
      content: '',
      ts: Date.now(),
      streaming: true,
    };

    let threadId = store.activeThreadId;
    if (!threadId || !store.threads.some((t) => t.id === threadId)) {
      threadId = uid();
      const thread: Thread = {
        id: threadId,
        title: threadTitle(text || 'Image question'),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [userMessage, assistantMessage],
      };
      setStore((s) => ({ ...s, threads: [...s.threads, thread], activeThreadId: threadId }));
    } else {
      updateActiveThread((t) => ({
        ...t,
        updatedAt: Date.now(),
        messages: [...t.messages, userMessage, assistantMessage],
      }));
    }

    // Payload: prior turns only — the server appends evidence to the question itself.
    // Window to the server's history budget and drop blank turns (an aborted stream
    // can leave an empty assistant bubble) so derived state can never fail validation.
    const HISTORY_PAYLOAD_TURNS = 10; // mirrors the server's MAX_HISTORY_MESSAGES
    const historyPayload = (activeThread?.messages ?? [])
      .filter((m) => !m.errorCode && m.content.trim().length > 0)
      .slice(-HISTORY_PAYLOAD_TURNS)
      .map((m) => ({ role: m.role, content: m.content }));
    historyPayload.push({ role: 'user', content: text });

    setComposer('');
    const sentImage = image;
    if (sentImage) rememberPreview(userMessage.id, sentImage.previewUrl);
    setImage(null);
    setSending(true);
    setAwaitingFirstToken(true);
    setChatPhase('typing');

    const controller = new AbortController();
    abortRef.current = controller;

    const patchAssistant = (patch: Partial<Message>) => {
      setStore((s) => ({
        ...s,
        threads: s.threads.map((t) =>
          t.id !== threadId
            ? t
            : {
                ...t,
                updatedAt: Date.now(),
                messages: t.messages.map((m) => (m.id === assistantMessage.id ? { ...m, ...patch } : m)),
              },
        ),
      }));
    };

    void streamChat(historyPayload, sentImage, {
      onStatus: (status) => {
        // 'warming' pins the warm-up line, 'reviewing' pins the closed-door review
        // line; any other status hands back to the normal progress cycle.
        if (status.phase === 'warming') setChatPhase('warming');
        else if (status.phase === 'reviewing') setChatPhase('reviewing');
        else setChatPhase('typing');
      },
      onDelta: (delta) => {
        setAwaitingFirstToken(false);
        setChatPhase('typing');
        setStore((s) => ({
          ...s,
          threads: s.threads.map((t) =>
            t.id !== threadId
              ? t
              : {
                  ...t,
                  messages: t.messages.map((m) =>
                    m.id === assistantMessage.id ? { ...m, content: m.content + delta } : m,
                  ),
                },
          ),
        }));
      },
      onMeta: (meta) => {
        // The answer arrives once, settled by the closed-door review; `revised`
        // marks answers the reviewer rewrote, so the badge reflects the final text.
        const mode = isGroundingMode(meta.mode) ? meta.mode : undefined;
        const followUps = sanitizeFollowUps(meta.followUps);
        patchAssistant({
          ...(meta.citations ? { citations: meta.citations } : {}),
          ...(meta.revised ? { revised: true } : {}),
          ...(mode !== undefined ? { mode } : {}),
          ...(followUps ? { followUps } : {}),
        });
      },
      onError: (err) => {
        setAwaitingFirstToken(false);
        patchAssistant({ content: err.message, errorCode: err.code, streaming: false });
        if (err.code === 'EXHAUSTED') {
          setAwakeState('asleep');
          setRetryAfter(err.retryAfter);
        }
      },
      onDone: () => {
        patchAssistant({ streaming: false });
      },
    }, controller.signal, depth)
      .catch(() => {
        // Aborts and network failures land here; the message keeps whatever tokens
        // arrived. If none did, drop the placeholder rather than leave an empty
        // bubble in the thread (which would also fail server validation next send).
        setStore((s) => ({
          ...s,
          threads: s.threads.map((t) =>
            t.id !== threadId
              ? t
              : {
                  ...t,
                  messages: t.messages
                    .map((m) => (m.id === assistantMessage.id ? { ...m, streaming: false } : m))
                    .filter((m) => m.id !== assistantMessage.id || m.content.trim().length > 0),
                },
          ),
        }));
      })
      .finally(() => {
        setSending(false);
        setAwaitingFirstToken(false);
        abortRef.current = null;
      });
  };

  const handleStop = () => abortRef.current?.abort();

  const handleDepthChange = (next: Depth) => {
    setDepth(next);
    saveDepth(next);
  };

  // First rating on a message is sent once. The same thumb again is ignored.
  // A later change updates the local mark and does not send a second vote.
  const handleRate = (id: string, rating: 'up' | 'down') => {
    const message = store.threads.flatMap((thread) => thread.messages).find((item) => item.id === id);
    if (!message || message.role !== 'assistant' || message.rating === rating) return;
    const firstVote = message.rating === undefined && !feedbackSentRef.current.has(id);
    if (firstVote) feedbackSentRef.current.add(id);
    setStore((current) => ({
      ...current,
      threads: current.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((item) => (item.id === id ? { ...item, rating } : item)),
      })),
    }));
    if (firstVote) void sendFeedback(rating, message.mode);
  };

  const handleAsk = (question: string) => {
    send(question);
  };

  // Retry a failed exchange: drop the error answer and its question, then resend the question.
  const handleRetry = (failedAssistantId: string) => {
    if (!activeThread || sending || asleep) return;
    const msgs = activeThread.messages;
    const idx = msgs.findIndex((m) => m.id === failedAssistantId && m.errorCode);
    if (idx < 0) return;
    const question = [...msgs.slice(0, idx)].reverse().find((m) => m.role === 'user');
    if (!question) return;
    forgetPreviews([question.id]);
    updateActiveThread((t) => ({
      ...t,
      messages: t.messages.filter((m) => m.id !== failedAssistantId && m.id !== question.id),
    }));
    window.setTimeout(() => send(question.content), 0);
  };

  // ---- thread management -----------------------------------------------------------

  const handleNewChat = () => {
    if (sending) handleStop();
    setStore((s) => ({ ...s, activeThreadId: null }));
    setComposer('');
    setDrawerOpen(false);
  };

  const handleSelectThread = (id: string) => {
    if (sending) handleStop();
    setStore((s) => ({ ...s, activeThreadId: id }));
    setDrawerOpen(false);
  };

  const handleDeleteThread = (id: string) => {
    const doomed = store.threads.find((t) => t.id === id);
    if (doomed) forgetPreviews(doomed.messages.map((m) => m.id));
    setStore((s) => {
      const threads = s.threads.filter((t) => t.id !== id);
      return {
        ...s,
        threads,
        activeThreadId: s.activeThreadId === id ? null : s.activeThreadId,
      };
    });
  };

  const handleClearAll = () => {
    if (sending) handleStop();
    forgetPreviews(Object.keys(previewsRef.current));
    clearStore();
    setStore({ version: 1, theme, threads: [], activeThreadId: null });
    setDrawerOpen(false);
  };

  // ---- export -------------------------------------------------------------------------

  const handleExport = () => {
    if (!activeThread || activeThread.messages.length === 0) return;
    const md = exportThreadMarkdown(activeThread);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const slug = activeThread.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'ask-satoshi';
    a.href = url;
    a.download = `${slug}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ---- render -----------------------------------------------------------------------

  return (
    <div className="app">
      {view === 'landing' || !activeThread ? (
        <main className="landing">
          <div className="landing-topbar">
            {store.threads.length > 0 && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open chat history"
              >
                <MenuIcon size={18} />
              </button>
            )}
            <div className="landing-topbar-end">
              <ThemeToggle theme={theme} onToggle={() => setTheme(theme === 'light' ? 'dark' : 'light')} />
            </div>
          </div>
          <div className="landing-centre">
            <Hero interacting={composerFocused || composer.length > 0} />
            <Composer
              value={composer}
              onChange={setComposer}
              onSubmit={() => send()}
              onStop={handleStop}
              disabled={false}
              asleep={asleep}
              sending={sending}
              listening={listening}
              speechSupported={recogniser.supported}
              onMicToggle={handleMicToggle}
              image={image}
              imagePending={imagePending}
              onAttach={handleAttach}
              onRemoveImage={handleRemoveImage}
              onFocusChange={setComposerFocused}
              depth={depth}
              onDepthChange={handleDepthChange}
            />
            {asleep && <SleepBanner retryAfter={retryAfter} lines={sleepLines} />}
            <Suggestions onPick={(q) => send(q)} disabled={asleep || sending} />
          </div>
          <footer className="landing-footer">
            <AiNotice className="landing-footer-copy" />
            <CorpusStamp updated={corpusUpdated} />
          </footer>
        </main>
      ) : (
        <ChatView
          messages={activeThread.messages}
          awaitingFirstToken={awaitingFirstToken}
          chatPhase={chatPhase}
          sending={sending}
          composerValue={composer}
          onComposerChange={setComposer}
          onSubmit={() => send()}
          onStop={handleStop}
          onRetry={handleRetry}
          asleep={asleep}
          retryAfter={retryAfter}
          sleepLines={sleepLines}
          listening={listening}
          speechSupported={recogniser.supported}
          onMicToggle={handleMicToggle}
          image={image}
          imagePending={imagePending}
          userImageUrls={userImageUrls}
          onAttach={handleAttach}
          onRemoveImage={handleRemoveImage}
          theme={theme}
          onThemeToggle={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          onOpenHistory={() => setDrawerOpen(true)}
          onNewChat={handleNewChat}
          onExport={handleExport}
          showStorageNotice={!store.storageNoticeSeen}
          onDismissStorageNotice={() => setStore((s) => ({ ...s, storageNoticeSeen: true }))}
          onRate={handleRate}
          onAsk={handleAsk}
          depth={depth}
          onDepthChange={handleDepthChange}
          corpusUpdated={corpusUpdated}
        />
      )}

      <HistoryDrawer
        open={drawerOpen}
        threads={store.threads}
        activeThreadId={store.activeThreadId}
        onClose={() => setDrawerOpen(false)}
        onSelect={handleSelectThread}
        onNew={handleNewChat}
        onDelete={handleDeleteThread}
        onClearAll={handleClearAll}
      />

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

function joinDictation(base: string, addition: string): string {
  const trimmed = addition.trim();
  if (!trimmed) return base;
  return base ? `${base.replace(/\s+$/, '')} ${trimmed}` : trimmed;
}
