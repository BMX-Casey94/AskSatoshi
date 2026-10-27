import { describe, expect, it } from 'vitest';
import { TTS_VOICE_DISCLOSURE, TTS_VOICE_LABEL } from './ttsVoice';

describe('TTS voice disclosure', () => {
  it('states that the voice is an AI-generated recreation and not a recording', () => {
    expect(TTS_VOICE_DISCLOSURE).toBe(
      "This voice is an AI-generated recreation of Dr. Craig Steven Wright's voice. It is not a recording of him.",
    );
    expect(TTS_VOICE_LABEL).toBe('AI-generated voice');
  });

  it('does not claim permission, endorsement or a licence', () => {
    const text = `${TTS_VOICE_LABEL} ${TTS_VOICE_DISCLOSURE}`.toLowerCase();
    expect(text).not.toMatch(/permission|endors|licen[cs]e|authori[sz]ed|consent/);
  });
});
