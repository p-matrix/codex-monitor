// =============================================================================
// breach-support.test.ts — getApprovalStatus narrowing + counter behavior
//
// Coverage:
//   1. getApprovalStatus — undefined / partial / valid record narrowing
//   2. recordApprovalRequested → 'pending'
//   3. recordApprovalGranted → 'granted'
//   4. recordApprovalDenied → 'denied'
//   5. inferDelegatedActionType — known tool → AP-x mapping
//   6. enrichMetadata — recent blocked actions injected
//   7. Tool / file / errors / denied counters
// =============================================================================

import { BreachSupport } from '../breach-support';

describe('BreachSupport.getApprovalStatus — narrowing edge cases', () => {

  test('returns null when action_id has no record', () => {
    const bs = new BreachSupport('agent-1');
    expect(bs.getApprovalStatus('does-not-exist')).toBeNull();
  });

  test('requested → pending', () => {
    const bs = new BreachSupport('agent-1');
    bs.recordApprovalRequested('act-1', 'bash');
    expect(bs.getApprovalStatus('act-1')).toBe('pending');
  });

  test('granted record returned even if older "requested" exists', () => {
    const bs = new BreachSupport('agent-1');
    bs.recordApprovalRequested('act-2', 'bash');
    bs.recordApprovalGranted('act-2');
    expect(bs.getApprovalStatus('act-2')).toBe('granted');
  });

  test('denied record returned for most recent', () => {
    const bs = new BreachSupport('agent-1');
    bs.recordApprovalRequested('act-3', 'bash');
    bs.recordApprovalDenied('act-3');
    expect(bs.getApprovalStatus('act-3')).toBe('denied');
  });

  test('multiple distinct action_ids do not cross-contaminate', () => {
    const bs = new BreachSupport('agent-1');
    bs.recordApprovalGranted('a');
    bs.recordApprovalDenied('b');
    expect(bs.getApprovalStatus('a')).toBe('granted');
    expect(bs.getApprovalStatus('b')).toBe('denied');
  });
});

describe('BreachSupport — counters', () => {
  test('tool / file / error / denied counters increment independently', () => {
    const bs = new BreachSupport('agent-2');
    bs.incrementToolCalls();
    bs.incrementToolCalls();
    bs.incrementFileModifications();
    bs.incrementErrors();
    bs.incrementDenied();
    expect(bs.getToolCallCount()).toBe(2);
    expect(bs.getFileModCount()).toBe(1);

    const report = bs.getSessionReport();
    expect(report.actions_summary.tool_calls_count).toBe(2);
    expect(report.actions_summary.file_modifications_count).toBe(1);
    expect(report.actions_summary.errors_count).toBe(1);
    expect(report.actions_summary.denied_count).toBe(1);
  });
});

describe('BreachSupport — inferDelegatedActionType', () => {
  test('shell-like tools map to AP-1', () => {
    const bs = new BreachSupport('agent-3');
    expect(bs.inferDelegatedActionType('bash')).toBe('AP-1');
    expect(bs.inferDelegatedActionType('execute_command')).toBe('AP-1');
  });

  test('file tools map to AP-2', () => {
    const bs = new BreachSupport('agent-3');
    expect(bs.inferDelegatedActionType('write_file')).toBe('AP-2');
    expect(bs.inferDelegatedActionType('read_file')).toBe('AP-2');
  });

  test('network tools map to AP-3', () => {
    const bs = new BreachSupport('agent-3');
    expect(bs.inferDelegatedActionType('http_request')).toBe('AP-3');
  });

  test('unknown tool → AP-1 default', () => {
    const bs = new BreachSupport('agent-3');
    expect(bs.inferDelegatedActionType('something_new')).toBe('AP-1');
  });

  test('no last tool → undefined', () => {
    const bs = new BreachSupport('agent-3');
    expect(bs.inferDelegatedActionType()).toBeUndefined();
  });
});

describe('BreachSupport — enrichMetadata', () => {
  test('blocked actions appear in metadata when within window', () => {
    const bs = new BreachSupport('agent-4');
    bs.recordBlockedAction('bash', 'rm -rf detected');
    const md = bs.enrichMetadata({});
    expect(md['blocked_action_history']).toBeDefined();
    expect(Array.isArray(md['blocked_action_history'])).toBe(true);
    expect((md['blocked_action_history'] as unknown[]).length).toBeGreaterThan(0);
  });

  test('no blocked actions → no blocked_action_history key', () => {
    const bs = new BreachSupport('agent-4');
    const md = bs.enrichMetadata({});
    expect(md['blocked_action_history']).toBeUndefined();
  });
});
