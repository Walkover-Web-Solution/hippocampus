import {
    extractNamedEntities, extractNames, normalizeEntityName, normalizeLabels, normalizeRelations, normalizeSlot, normalizeTypedEntities, PRIVATE_DETAIL, queryTerms,
} from '../text';

describe('memory text normalisation', () => {
    it('spells a name the same way every time', () => {
        expect(normalizeEntityName('Acme Inc.')).toBe('acme inc');
        expect(normalizeEntityName('  "HubSpot" ')).toBe('hubspot');
        expect(normalizeEntityName('the')).toBeNull();
        expect(normalizeEntityName('x')).toBeNull();
    });

    it('keeps one typed node per name, a real type beating "other"', () => {
        expect(normalizeTypedEntities([{ name: 'Acme', type: 'other' }, { name: 'acme', type: 'organisation' }, { name: 'Acme', type: 'person' }]))
            .toEqual([{ name: 'acme', type: 'organisation' }]);
        expect(normalizeTypedEntities([{ name: 'x', type: 'nonsense' }, { name: 'slack', type: 'nonsense' }])).toEqual([{ name: 'slack', type: 'other' }]);
    });

    it('normalises relations and drops self-links and repeats', () => {
        expect(normalizeRelations([
            { subject: 'Acme', relation: 'Uses!', object: 'HubSpot' },
            { subject: 'acme', relation: 'uses', object: 'hubspot' },
            { subject: 'acme', relation: 'is', object: 'acme' },
            { subject: '', relation: 'uses', object: 'x' },
        ])).toEqual([{ subject: 'acme', relation: 'uses', object: 'hubspot' }]);
    });

    it('normalises slots and labels', () => {
        expect(normalizeSlot('Tone of voice')).toBe('tone_of_voice');
        expect(normalizeSlot('')).toBeNull();
        expect(normalizeLabels(['Billing ', 'billing', 'onboarding'])).toEqual(['billing', 'onboarding']);
        expect(normalizeLabels('single')).toEqual(['single']);
        expect(normalizeLabels(Array.from({ length: 15 }, (_, i) => `l${i}`))).toHaveLength(10);
    });

    it('finds channels, handles and domains but never email addresses', () => {
        const entities = extractNamedEntities('Post in #payments, ping @maya, see acme.com; mail bob@acme.com');
        expect(entities).toEqual(expect.arrayContaining([{ name: '#payments', type: 'channel' }, { name: '@maya', type: 'other' }, { name: 'acme.com', type: 'other' }]));
        expect(entities.some((entity) => entity.name.includes('bob@'))).toBe(false);
        expect(extractNames('Draft the Acme email for Monday. Then rest.')).toEqual(expect.arrayContaining(['acme', 'monday']));
        expect(extractNames('Then rest.')).not.toContain('then');
    });

    it('turns a query into names and a keyword query', () => {
        const terms = queryTerms('When is the Acme launch in #payments?');
        expect(terms.names).toEqual(expect.arrayContaining(['acme', 'launch', '#payments', 'acme launch']));
        expect(terms.keywordQuery).toBe('acme | launch | payments');
        expect(queryTerms('the and of').keywordQuery).toBeNull();
    });

    it('spots private details', () => {
        expect(PRIVATE_DETAIL.test('call me on 9876543210')).toBe(true);
        expect(PRIVATE_DETAIL.test('mail maya@acme.com')).toBe(true);
        expect(PRIVATE_DETAIL.test('launching on November 3')).toBe(false);
    });
});
