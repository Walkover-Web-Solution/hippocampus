import { groupConnections, renderPrompt } from '../prompt';
import { EntityLink, NoteRow, SearchHit } from '../types';

const note = (over: Partial<NoteRow>): NoteRow => ({
    id: 'n', space_id: 's', space: 'users/maya', path: 'facts/x', kind: 'fact', slot: null, labels: [], current_version_id: 'v', status: 'active',
    valid_from: new Date('2026-01-01'), valid_to: null, source: null, written_by: 'test', confidence: null, evidence_count: 1,
    created_at: new Date('2026-03-03'), updated_at: new Date('2026-03-03'), version: 1, version_id: 'v', title: null, summary: null,
    version_written_by: 'test', change: 'write', version_created_at: new Date('2026-03-03'), ...over,
});
const hit = (text: string, over: Partial<NoteRow> = {}): SearchHit => ({ note: note(over), excerpt: text, ordinal: 0, distance: 0.3, score: 0.7 });
const link = (subject: string, relation: string, object: string): EntityLink => ({ subject, relation, object, space: 'users/maya', path: 'facts/x', asOf: new Date(), until: null });

describe('memory prompt block', () => {
    it('is null when nothing applies', () => {
        expect(renderPrompt({ rules: [], hits: [], lessons: [], connections: [] })).toBeNull();
    });

    it('lists rules first with their slots, notes with dates, connections and lessons', () => {
        const text = renderPrompt({
            rules: [note({ kind: 'rule', slot: 'tone', body: 'Prefers a casual tone.' })],
            hits: [hit('Acme is on the Business plan.', { path: 'facts/acme-plan' })],
            lessons: [hit('Refund tickets are billing.', { kind: 'lesson', evidence_count: 3 })],
            connections: groupConnections(['acme'], [link('acme', 'uses', 'hubspot'), link('maya', 'works_at', 'acme'), link('acme', 'uses', 'hubspot')]),
        }) as string;
        expect(text.startsWith('## What you remember')).toBe(true);
        expect(text.indexOf('Rules:')).toBeLessThan(text.indexOf('Relevant notes:'));
        expect(text).toContain('- (tone) Prefers a casual tone.');
        expect(text).toContain('Acme is on the Business plan. (users/maya/facts/acme-plan, as of 3 Mar 2026)');
        expect(text).toContain('- acme: → uses hubspot; ← maya works at');
        expect(text).toContain('Refund tickets are billing. (confirmed 3 times)');
    });

    it('stays within budget by dropping the weakest items first', () => {
        const long = 'x'.repeat(290);
        const text = renderPrompt({
            rules: [note({ kind: 'rule', slot: 'tone', body: 'Casual.' })],
            hits: Array.from({ length: 30 }, (_, i) => hit(`${long} ${i}`)),
            lessons: [hit('lesson one'), hit('lesson two')],
            connections: [],
        }) as string;
        expect(text.length).toBeLessThanOrEqual(4000);
        expect(text).toContain('Casual.');
        expect(text).not.toContain('lesson two');
    });
});
