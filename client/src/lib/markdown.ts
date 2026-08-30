/**
 * Markdown rendering for assistant messages and source excerpts. Everything passes
 * through DOMPurify — model output is untrusted content and must never reach the DOM raw.
 */

import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const md = new MarkdownIt({
  html: false, // never pass raw HTML through
  linkify: true,
  breaks: true,
});

// Open links in a new tab with safe rel.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]?.attrSet('target', '_blank');
  tokens[idx]?.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.render(text), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'svg', 'math'],
    // Only web-safe link protocols — blocks javascript:, data:, vbscript: etc.
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
  });
}
