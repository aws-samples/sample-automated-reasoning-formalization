import { describe, it, expect } from 'vitest';
import { translateCliError } from './cli-error-translate';

describe('translateCliError', () => {
  // ── stderr: surfaces actual error messages ──

  it('surfaces "not logged in" with the actual message', () => {
    const result = translateCliError({ type: 'stderr', message: 'Error: not logged in' });
    expect(result).toEqual({ message: 'Error: not logged in', type: 'warning' });
  });

  it('surfaces auth token errors with the actual message', () => {
    const result = translateCliError({ type: 'stderr', message: 'authentication token expired' });
    expect(result).toEqual({ message: 'authentication token expired', type: 'warning' });
  });

  it('surfaces generic error messages', () => {
    const result = translateCliError({ type: 'stderr', message: 'ECONNREFUSED error connecting to service' });
    expect(result).toEqual({ message: 'ECONNREFUSED error connecting to service', type: 'warning' });
  });

  it('surfaces fatal messages', () => {
    const result = translateCliError({ type: 'stderr', message: 'fatal: something broke' });
    expect(result).toEqual({ message: 'fatal: something broke', type: 'warning' });
  });

  // ── stderr: noise filtering ──

  it('filters out debug-prefixed lines', () => {
    expect(translateCliError({ type: 'stderr', message: '[debug] checking state' })).toBeNull();
  });

  it('filters out info-prefixed lines', () => {
    expect(translateCliError({ type: 'stderr', message: '[info] starting up' })).toBeNull();
  });

  it('filters out trace-prefixed lines', () => {
    expect(translateCliError({ type: 'stderr', message: '[trace] verbose output' })).toBeNull();
  });

  it('filters out short non-error messages', () => {
    expect(translateCliError({ type: 'stderr', message: '[kiro]' })).toBeNull();
  });

  it('filters out empty messages', () => {
    expect(translateCliError({ type: 'stderr', message: '' })).toBeNull();
  });

  it('filters out whitespace-only messages', () => {
    expect(translateCliError({ type: 'stderr', message: '   ' })).toBeNull();
  });

  it('filters out non-error informational output', () => {
    expect(translateCliError({ type: 'stderr', message: 'some informational output here' })).toBeNull();
  });

  // ── exit events ──

  it('treats exit code 0 as info-level disconnect', () => {
    const result = translateCliError({ type: 'exit', code: 0 });
    expect(result?.type).toBe('info');
  });

  it('treats exit code null (signal) as info-level disconnect', () => {
    const result = translateCliError({ type: 'exit', code: null });
    expect(result?.type).toBe('info');
  });

  it('treats non-zero exit code as error with code in message', () => {
    const result = translateCliError({ type: 'exit', code: 1 });
    expect(result?.type).toBe('error');
    expect(result?.message).toContain('exit code 1');
  });

  it('treats exit code 137 (SIGKILL) as error', () => {
    const result = translateCliError({ type: 'exit', code: 137 });
    expect(result?.type).toBe('error');
    expect(result?.message).toContain('exit code 137');
  });
});
