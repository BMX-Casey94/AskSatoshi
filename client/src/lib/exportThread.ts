/**
 * Export a chat thread as a self-contained Markdown document. Includes the question,
 * each answer, and the cited sources with their provenance class and links, so the
 * record is useful outside the app.
 */

import type { Thread } from '../types';

const CLASS_LABEL: Record<string, string> = {
  'satoshi-primary': "Satoshi's writings (2008–2011)",
  spec: 'Protocol specification',
  'later-commentary': 'Later commentary',
};

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function exportThreadMarkdown(thread: Thread): string {
  const lines: string[] = [];
  lines.push(`# ${thread.title}`);
  lines.push('');
  lines.push(
    `_Exported from Ask Satoshi — an AI speaking in Satoshi's voice, not Satoshi Nakamoto. ${fmtDate(thread.updatedAt)}._`,
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const m of thread.messages) {
    if (m.role === 'user') {
      lines.push(`## You`);
      lines.push('');
      lines.push(m.content.trim());
      lines.push('');
      continue;
    }
    // assistant
    lines.push(`## Satoshi`);
    lines.push('');
    if (m.errorCode) {
      lines.push(`> ⚠ ${m.content.trim()}`);
      lines.push('');
      continue;
    }
    lines.push(m.content.trim());
    lines.push('');
    if (m.citations && m.citations.length > 0) {
      lines.push('**Sources**');
      lines.push('');
      m.citations.forEach((c, i) => {
        const label = c.title ?? c.label;
        const cls = c.sourceClass ? ` — _${CLASS_LABEL[c.sourceClass] ?? c.sourceClass}_` : '';
        const link = c.url ? `[${label}](${c.url})` : label;
        lines.push(`${i + 1}. ${link}${cls}`);
      });
      lines.push('');
    }
  }

  return lines.join('\n');
}
