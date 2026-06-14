import { describe, expect, it } from 'vitest';
import { detectVisionFromName, effectiveVision, resolveModelVision } from '../src/capabilities';

describe('detectVisionFromName', () => {
  it.each([
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'openai/gpt-4o',
    'claude-3-5-sonnet',
    'anthropic/claude-3.5-sonnet',
    'claude-sonnet-4',
    'gemini-1.5-pro',
    'google/gemini-2.0-flash',
    'llama-3.2-90b-vision-instruct',
    'llava:13b',
    'qwen2.5-vl-7b',
    'pixtral-12b',
    'moondream',
  ])('%s → vision true', (id) => {
    expect(detectVisionFromName(id)).toBe(true);
  });

  it.each([
    'text-embedding-3-small',
    'whisper-1',
    'gpt-3.5-turbo',
    'codellama:7b',
    'deepseek-coder',
  ])('%s → text-only false', (id) => {
    expect(detectVisionFromName(id)).toBe(false);
  });

  it.each(['some-random-model', 'mistral-7b', 'mythomax'])('%s → unknown', (id) => {
    expect(detectVisionFromName(id)).toBe('unknown');
  });
});

describe('resolveModelVision — provider metadata wins', () => {
  it('provider true/false overrides the name heuristic', () => {
    expect(resolveModelVision('gpt-3.5-turbo', true)).toBe(true); // provider says yes
    expect(resolveModelVision('gpt-4o', false)).toBe(false); // provider says no
  });
  it('falls back to the name when provider is silent', () => {
    expect(resolveModelVision('gpt-4o', undefined)).toBe(true);
    expect(resolveModelVision('gpt-4o', 'unknown')).toBe(true);
    expect(resolveModelVision('mystery', undefined)).toBe('unknown');
  });
});

describe('effectiveVision — the run gate', () => {
  it('override true/false wins over detection', () => {
    expect(effectiveVision({ vision: false }, true)).toBe(true);
    expect(effectiveVision({ vision: true }, false)).toBe(false);
  });
  it('without override: only true passes; unknown/undefined/false block', () => {
    expect(effectiveVision({ vision: true })).toBe(true);
    expect(effectiveVision({ vision: 'unknown' })).toBe(false);
    expect(effectiveVision({ vision: false })).toBe(false);
    expect(effectiveVision({})).toBe(false);
  });
});
