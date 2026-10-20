import { chunkText, firstSentence } from '../chunker';

describe('memory chunker', () => {
    it('keeps a short note as one chunk', () => {
        expect(chunkText('Prefers a soft, friendly tone.')).toEqual([{ ordinal: 0, text: 'Prefers a soft, friendly tone.' }]);
        expect(chunkText('   ')).toEqual([]);
    });

    it('splits a long body on paragraphs with overlap', () => {
        const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} says something about topic ${i + 1} in a few words. It goes on a little longer so that it has some length.`);
        const chunks = chunkText(paragraphs.join('\n\n'), { size: 400, overlap: 60 });
        expect(chunks.length).toBeGreaterThan(2);
        expect(chunks.every((chunk) => chunk.text.length <= 400)).toBe(true);
        expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, i) => i));
        // Every paragraph is in some chunk.
        for (const paragraph of paragraphs) expect(chunks.some((chunk) => chunk.text.includes(paragraph))).toBe(true);
        // Overlap: the second chunk starts with the tail of the first, from a word boundary inside the last 60 characters.
        const last = chunks[0].text.slice(-60);
        const carried = last.slice(last.search(/\s/) + 1);
        expect(carried.length).toBeGreaterThan(0);
        expect(chunks[1].text.startsWith(carried)).toBe(true);
    });

    it('hard-cuts a sentence longer than the size', () => {
        const chunks = chunkText('x'.repeat(2000), { size: 500, overlap: 50 });
        expect(chunks.length).toBeGreaterThanOrEqual(4);
        expect(chunks.every((chunk) => chunk.text.length <= 500)).toBe(true);
    });

    it('summarises a body by its first sentence', () => {
        expect(firstSentence('Acme is on the Business plan. They pay yearly.')).toBe('Acme is on the Business plan.');
        expect(firstSentence('No punctuation here')).toBe('No punctuation here');
        expect(firstSentence('a'.repeat(300), 50)).toHaveLength(50);
    });
});
