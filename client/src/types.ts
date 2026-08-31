/** Where a source sits in the evidentiary hierarchy. */
export type SourceClass = 'satoshi-primary' | 'spec' | 'later-commentary' | 'historical-record';

export interface Citation {
  label: string;
  /** Human-readable source title, when known. */
  title?: string;
  /** Real, clickable web URL — never an internal locator. Omitted when none exists. */
  url?: string;
  /** Short excerpt from the source, for the citation detail panel. */
  excerpt?: string;
  /** ISO date (YYYY-MM-DD or full) when known — shown above Quoted remarks. */
  date?: string;
  /** Evidentiary class — drives the provenance chip in the UI. */
  sourceClass?: SourceClass;
}

export type MessageRole = 'user' | 'assistant';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  ts: number;
  citations?: Citation[];
  /** Witty error code when this assistant message is an error rather than an answer. */
  errorCode?: string;
  /** True while tokens are still arriving. */
  streaming?: boolean;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export interface AttachedImage {
  /** Base64 without the data-URL prefix. */
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Object URL for the preview chip. */
  previewUrl: string;
  name: string;
}

export type AwakeState = 'awake' | 'asleep' | 'unconfigured';

export interface StatusResponse {
  state: AwakeState;
  retryAfter?: string;
  sleepLines?: string[];
}

export type ActivityKind = 'posts' | 'emails';

export interface ActivityPoint {
  date: string;
  kind: string;
  title: string;
  url: string;
}

export interface SatoshiActivityResponse {
  generatedAt: string;
  total: number;
  byKind: { emails: number; posts: number };
  points: ActivityPoint[];
}
