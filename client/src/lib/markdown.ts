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

/**
 * Strip markdown to the spoken plain text: walk markdown-it's token stream and
 * keep text (including code and image alt), drop formatting/link markup, then
 * collapse runs of 3+ newlines. Quote and speak this exact string.
 */
export function renderPlainText(text: string): string {
  const tokens = md.parse(text, {});
  const parts: string[] = [];

  const walk = (list: typeof tokens): void => {
    for (const token of list) {
      if (token.type === 'inline' && token.children) {
        walk(token.children);
        continue;
      }
      switch (token.type) {
        case 'text':
        case 'code_inline':
          parts.push(token.content);
          break;
        case 'softbreak':
          parts.push(' ');
          break;
        case 'hardbreak':
          parts.push('\n');
          break;
        case 'image': {
          const rawAlt = token.content || token.attrGet('alt') || '';
          const alt = typeof rawAlt === 'string' ? rawAlt : String(rawAlt);
          if (alt) parts.push(alt);
          break;
        }
        case 'fence':
        case 'code_block':
          if (token.content) {
            parts.push(token.content.endsWith('\n') ? token.content : `${token.content}\n`);
          }
          break;
        default:
          if (token.block && token.type.endsWith('_close')) {
            parts.push('\n');
          }
      }
    }
  };

  walk(tokens);
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
