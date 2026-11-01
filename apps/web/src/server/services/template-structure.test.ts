import { describe, expect, it } from 'vitest';
import { BUILT_IN_TEMPLATES, templateStructure } from './template-structure';

describe('board templates', () => {
  it('ships built-ins that are valid and internally consistent', () => {
    const keys = new Set<string>();
    for (const template of BUILT_IN_TEMPLATES) {
      expect(keys.has(template.key)).toBe(false);
      keys.add(template.key);
      const parsed = templateStructure.parse(template.structure);
      const labelNames = new Set(parsed.labels.map((label) => label.name));
      for (const card of parsed.cards) {
        expect(card.column).toBeLessThan(parsed.columns.length);
        for (const label of card.labels) expect(labelNames.has(label)).toBe(true);
      }
      // Every board needs somewhere for finished work to go.
      expect(parsed.columns.some((column) => column.category === 'DONE')).toBe(true);
    }
    expect(BUILT_IN_TEMPLATES[0]?.key).toBe('simple');
  });

  it('rejects damaged saved structures', () => {
    expect(templateStructure.safeParse({ columns: [] }).success).toBe(false);
    expect(templateStructure.safeParse({ columns: [{ name: 'A', category: 'NOPE' }] }).success).toBe(false);
    expect(templateStructure.safeParse({ columns: [{ name: 'A', category: null }], labels: [{ name: 'x', color: '#fff' }] }).success).toBe(false);
  });

  it('fills defaults for older saved templates', () => {
    const parsed = templateStructure.parse({ columns: [{ name: 'A', category: 'TODO' }] });
    expect(parsed).toEqual({ columns: [{ name: 'A', category: 'TODO', wipLimit: null }], labels: [], cards: [] });
  });
});
