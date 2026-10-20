import { ApiError } from '../../error/api-error';
import { applyEdits } from '../store/notes';

const note = ['# Pricing', '', 'Starter is $10.', 'Pro is $30.', 'Enterprise is custom.'].join('\n');

describe('memory edits', () => {
    it('replaces one exact phrase', () => {
        expect(applyEdits(note, [{ op: 'str_replace', old: 'Pro is $30.', new: 'Pro is $35.' }])).toContain('Pro is $35.');
    });

    it('refuses a phrase that is missing or ambiguous', () => {
        expect(() => applyEdits(note, [{ op: 'str_replace', old: 'Gold is $50.', new: 'x' }])).toThrow(ApiError);
        expect(() => applyEdits(note, [{ op: 'str_replace', old: ' is $', new: 'x' }])).toThrow(/more than once/);
    });

    it('inserts after a line, at the top, and at the end', () => {
        const lines = applyEdits(note, [{ op: 'insert', line: 1, text: 'Updated today.' }]).split('\n');
        expect(lines[1]).toBe('Updated today.');
        expect(applyEdits(note, [{ op: 'insert', line: 0, text: 'TOP' }]).startsWith('TOP\n# Pricing')).toBe(true);
        expect(applyEdits(note, [{ op: 'append', text: 'Team is $20.' }]).endsWith('Enterprise is custom.\nTeam is $20.')).toBe(true);
        expect(applyEdits(note, [{ op: 'prepend', text: 'Draft' }]).startsWith('Draft\n# Pricing')).toBe(true);
        expect(() => applyEdits(note, [{ op: 'insert', line: 99, text: 'x' }])).toThrow(/outside/);
    });

    it('deletes one exact phrase and applies edits in order', () => {
        const edited = applyEdits(note, [
            { op: 'delete', old: 'Enterprise is custom.' },
            { op: 'str_replace', old: 'Starter is $10.', new: 'Starter is free.' },
            { op: 'append', text: 'Enterprise: ask sales.' },
        ]);
        expect(edited).not.toContain('Enterprise is custom.');
        expect(edited).toContain('Starter is free.');
        expect(edited.endsWith('Enterprise: ask sales.')).toBe(true);
    });

    it('works on an empty note', () => {
        expect(applyEdits('', [{ op: 'append', text: 'first line' }])).toBe('first line');
        expect(applyEdits('', [{ op: 'insert', line: 0, text: 'first line' }])).toBe('first line');
    });
});
