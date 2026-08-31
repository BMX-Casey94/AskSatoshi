/**
 * Ask Satoshi — application shell. Owns threads (localStorage), theme, the
 * awake/asleep service status, dictation, image attachment and the SSE chat flow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatView } from './components/ChatView';
import { Composer } from './components/Composer';
import { Hero } from './components/Hero';
import { HistoryDrawer } from './components/HistoryDrawer';
import { SleepBanner } from './components/SleepBanner';
import { Suggestions } from './components/Suggestions';
import { ThemeToggle } from './components/ThemeToggle';
import { MenuIcon } from './components/icons';
import { getStatus, streamChat } from './lib/api';
import { Link } from './lib/router';
import { exportThreadMarkdown } from './lib/exportThread';
import { createRecogniser } from './lib/speech';
import { clearStore, loadStore, saveStore } from './lib/storage';
import type { AttachedImage, AwakeState, Message, Thread } from './types';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

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
  const [composer, setComposer] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [awaitingFirstToken, setAwaitingFirstToken] = useState(false);
  const [chatPhase, setChatPhase] = useState<'warming' | 'typing'>('typing');
  const [awakeState, setAwakeState] = useState<AwakeState>('awake');
  const [retryAfter, setRetryAfter] = useState<string | undefined>();
  const [sleepLines, setSleepLines] = useState<string[] | undefined>();
  const [image, setImage] = useState<AttachedImage | null>(null);
  const [listening, setListening] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const recogniser = useMemo(() => createRecogniser(), []);
  // Dictated text accumulates here so interim results replace rather than append.
  const dictatedBaseRef = useRef('');

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

  const handleAttach = (file: File) => {
    if (file.type === 'application/x-rejected') {
      flashNotice('That image is heavier than a full block — PNG, JPEG or WebP, under 4 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      setImage({
        data: base64,
        mimeType: file.type as AttachedImage['mimeType'],
        previewUrl: URL.createObjectURL(file),
        name: file.name.length > 28 ? `${file.name.slice(0, 28)}…` : file.name,
      });
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveImage = () => {
    if (image) URL.revokeObjectURL(image.previewUrl);
    setImage(null);
  };

  // ---- dictation ---------------------------------------------------------------

  const handleMicToggle = () => {
    if (!recogniser.supported) {
      flashNotice('Your browser cannot hear me — Chrome or Edge will do the trick.');
      return;
    }
    if (listening) {
      recogniser.stop();
      setListening(false);
      return;
    }
    dictatedBaseRef.current = composer;
    recogniser.start({
      onInterim: (text) => setComposer(joinDictation(dictatedBaseRef.current, text)),
      onFinal: (text) => {
        dictatedBaseRef.current = joinDictation(dictatedBaseRef.current, text);
        setComposer(dictatedBaseRef.current);
      },
      onEnd: () => setListening(false),
      onError: () => {
        setListening(false);
        flashNotice('Dictation cut out — check your microphone and try again.');
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
    const text = (rawText ?? composer).trim();
    if (!text && !image) return;
    if (sending || asleep) return;
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
    const historyPayload = (activeThread?.messages ?? [])
      .filter((m) => !m.errorCode)
      .map((m) => ({ role: m.role, content: m.content }));
    historyPayload.push({ role: 'user', content: text });

    setComposer('');
    const sentImage = image;
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
        // 'warming' pins the warm-up line; the server's follow-up status hands back
        // to the normal progress cycle once the warm-up window closes.
        setChatPhase(status.phase === 'warming' ? 'warming' : 'typing');
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
        if (meta.citations) patchAssistant({ citations: meta.citations });
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
    }, controller.signal)
      .catch(() => {
        // Aborts land here; the message keeps whatever tokens arrived.
        patchAssistant({ streaming: false });
      })
      .finally(() => {
        setSending(false);
        setAwaitingFirstToken(false);
        abortRef.current = null;
      });
  };

  const handleStop = () => abortRef.current?.abort();

  // Retry a failed exchange: drop the error answer and its question, then resend the question.
  const handleRetry = (failedAssistantId: string) => {
    if (!activeThread || sending || asleep) return;
    const msgs = activeThread.messages;
    const idx = msgs.findIndex((m) => m.id === failedAssistantId && m.errorCode);
    if (idx < 0) return;
    const question = [...msgs.slice(0, idx)].reverse().find((m) => m.role === 'user');
    if (!question) return;
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
              onAttach={handleAttach}
              onRemoveImage={handleRemoveImage}
              onFocusChange={setComposerFocused}
            />
            {asleep && <SleepBanner retryAfter={retryAfter} lines={sleepLines} />}
            <Suggestions onPick={(q) => send(q)} disabled={asleep || sending} />
          </div>
          <footer className="landing-footer">
            <p className="landing-footer-copy">
              Grounded in the writings and the protocol record. Free to use; chats stay on your
              device.
            </p>
            <Link href="/satoshi-activity" className="landing-footer-link">
              Satoshi activity
            </Link>
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
          onAttach={handleAttach}
          onRemoveImage={handleRemoveImage}
          theme={theme}
          onThemeToggle={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          onOpenHistory={() => setDrawerOpen(true)}
          onNewChat={handleNewChat}
          onExport={handleExport}
          showStorageNotice={!store.storageNoticeSeen}
          onDismissStorageNotice={() => setStore((s) => ({ ...s, storageNoticeSeen: true }))}
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
