import { describe, it, expect } from 'vitest';
import { mapToolToActivityLabel } from './tool-labels';

describe('mapToolToActivityLabel', () => {
  it('maps policy definition tools', () => {
    expect(mapToolToActivityLabel('get-automated-reasoning-policy-definition')).toBe('📖 Flipping through your rulebook…');
    expect(mapToolToActivityLabel('export-automated-reasoning-policy')).toBe('📖 Flipping through your rulebook…');
  });

  it('maps test-related tools', () => {
    expect(mapToolToActivityLabel('get-automated-reasoning-policy-test-results')).toBe('🔍 Peeking at test results…');
    expect(mapToolToActivityLabel('list-automated-reasoning-policy-tests')).toBe('📋 Rounding up your tests…');
    expect(mapToolToActivityLabel('run-automated-reasoning-policy-test')).toBe('🧪 Running experiments…');
    expect(mapToolToActivityLabel('execute_tests')).toBe('🧪 Running experiments…');
  });

  it('maps rule mutation tools', () => {
    expect(mapToolToActivityLabel('add_rules')).toBe('⚙️ Wiring in new rules…');
    expect(mapToolToActivityLabel('delete_rules')).toBe('⚙️ Removing some rules…');
  });

  it('maps variable mutation tools', () => {
    expect(mapToolToActivityLabel('add_variables')).toBe('⚙️ Adding new variables…');
    expect(mapToolToActivityLabel('update_variables')).toBe('⚙️ Fine-tuning variables…');
    expect(mapToolToActivityLabel('delete_variables')).toBe('⚙️ Cleaning up variables…');
  });

  it('maps test mutation tools', () => {
    expect(mapToolToActivityLabel('update_tests')).toBe('⚙️ Adjusting test cases…');
    expect(mapToolToActivityLabel('delete_tests')).toBe('⚙️ Removing test cases…');
  });

  it('maps search and lookup tools', () => {
    expect(mapToolToActivityLabel('search_document')).toBe('🔎 Searching through your policy…');
    expect(mapToolToActivityLabel('search_rules')).toBe('🔎 Searching through your policy…');
    expect(mapToolToActivityLabel('search_variables')).toBe('🔎 Searching through your policy…');
    expect(mapToolToActivityLabel('find_related_content')).toBe('🔎 Tracing connections…');
    expect(mapToolToActivityLabel('get_rule_details')).toBe('🔎 Looking up the details…');
    expect(mapToolToActivityLabel('get_variable_details')).toBe('🔎 Looking up the details…');
    expect(mapToolToActivityLabel('get_section_rules')).toBe('🔎 Checking what this section covers…');
  });

  it('maps update/create policy wrappers', () => {
    expect(mapToolToActivityLabel('update-automated-reasoning-policy')).toBe('✏️ Tweaking your policy…');
    expect(mapToolToActivityLabel('create-automated-reasoning-policy')).toBe('🛠️ Crafting a fresh policy…');
  });

  it('maps document and section tools', () => {
    expect(mapToolToActivityLabel('read-document-sections')).toBe('📄 Scanning your document…');
    expect(mapToolToActivityLabel('import-section')).toBe('📄 Scanning your document…');
  });

  it('maps build and quality tools', () => {
    expect(mapToolToActivityLabel('build-policy')).toBe('🏗️ Building things up…');
    expect(mapToolToActivityLabel('get-fidelity-report')).toBe('✅ Giving it a quality check…');
    expect(mapToolToActivityLabel('check-quality-score')).toBe('✅ Giving it a quality check…');
  });

  it('maps scenario tools', () => {
    expect(mapToolToActivityLabel('generate-scenario')).toBe('🎭 Playing out scenarios…');
  });

  it('returns fallback for unknown tools', () => {
    expect(mapToolToActivityLabel('unknown-tool')).toBe('🔮 Gathering context…');
    expect(mapToolToActivityLabel('')).toBe('🔮 Gathering context…');
  });

  it('is case insensitive', () => {
    expect(mapToolToActivityLabel('GET-AUTOMATED-REASONING-POLICY-DEFINITION')).toBe('📖 Flipping through your rulebook…');
    expect(mapToolToActivityLabel('ADD_RULES')).toBe('⚙️ Wiring in new rules…');
  });
});
