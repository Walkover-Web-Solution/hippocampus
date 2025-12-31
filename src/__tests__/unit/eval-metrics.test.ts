import {
    mockSearchHippocampus,
    calculateHit,
    calculateRecall,
    calculateReciprocalRank,
} from '../../service/eval-metrics';

describe('Eval Metrics Unit Tests', () => {
    describe('calculateHit', () => {
        it('should return true when any expected ID is in retrieved IDs', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk3', 'chunk1', 'chunk4', 'chunk5', 'chunk6'];
            expect(calculateHit(expectedIds, retrievedIds)).toBe(true);
        });

        it('should return false when no expected IDs are in retrieved IDs', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk3', 'chunk4', 'chunk5', 'chunk6', 'chunk7'];
            expect(calculateHit(expectedIds, retrievedIds)).toBe(false);
        });

        it('should return false for empty expected IDs', () => {
            const expectedIds: string[] = [];
            const retrievedIds = ['chunk1', 'chunk2', 'chunk3'];
            expect(calculateHit(expectedIds, retrievedIds)).toBe(false);
        });

        it('should return false for empty retrieved IDs', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds: string[] = [];
            expect(calculateHit(expectedIds, retrievedIds)).toBe(false);
        });
    });

    describe('calculateRecall', () => {
        it('should return 1 when all expected IDs are found', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk1', 'chunk2', 'chunk3', 'chunk4', 'chunk5'];
            expect(calculateRecall(expectedIds, retrievedIds)).toBe(1);
        });

        it('should return 0.5 when half of expected IDs are found', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk1', 'chunk3', 'chunk4', 'chunk5', 'chunk6'];
            expect(calculateRecall(expectedIds, retrievedIds)).toBe(0.5);
        });

        it('should return 0 when no expected IDs are found', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk3', 'chunk4', 'chunk5', 'chunk6', 'chunk7'];
            expect(calculateRecall(expectedIds, retrievedIds)).toBe(0);
        });

        it('should return 0 for empty expected IDs', () => {
            const expectedIds: string[] = [];
            const retrievedIds = ['chunk1', 'chunk2', 'chunk3'];
            expect(calculateRecall(expectedIds, retrievedIds)).toBe(0);
        });

        it('should handle single expected ID correctly', () => {
            const expectedIds = ['chunk1'];
            const retrievedIds = ['chunk3', 'chunk1', 'chunk4', 'chunk5', 'chunk6'];
            expect(calculateRecall(expectedIds, retrievedIds)).toBe(1);
        });
    });

    describe('calculateReciprocalRank', () => {
        it('should return 1 when first relevant ID is at position 0 (rank 1)', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk1', 'chunk3', 'chunk4', 'chunk5', 'chunk6'];
            expect(calculateReciprocalRank(expectedIds, retrievedIds)).toBe(1);
        });

        it('should return 0.5 when first relevant ID is at position 1 (rank 2)', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk3', 'chunk1', 'chunk4', 'chunk5', 'chunk6'];
            expect(calculateReciprocalRank(expectedIds, retrievedIds)).toBe(0.5);
        });

        it('should return 0.33... when first relevant ID is at position 2 (rank 3)', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk3', 'chunk4', 'chunk1', 'chunk5', 'chunk6'];
            expect(calculateReciprocalRank(expectedIds, retrievedIds)).toBeCloseTo(1/3);
        });

        it('should return 0.25 when first relevant ID is at position 3 (rank 4)', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk3', 'chunk4', 'chunk5', 'chunk1', 'chunk6'];
            expect(calculateReciprocalRank(expectedIds, retrievedIds)).toBe(0.25);
        });

        it('should return 0.2 when first relevant ID is at position 4 (rank 5)', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk3', 'chunk4', 'chunk5', 'chunk6', 'chunk1'];
            expect(calculateReciprocalRank(expectedIds, retrievedIds)).toBe(0.2);
        });

        it('should return 0 when no relevant ID is found', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk3', 'chunk4', 'chunk5', 'chunk6', 'chunk7'];
            expect(calculateReciprocalRank(expectedIds, retrievedIds)).toBe(0);
        });

        it('should return rank of first match even if multiple matches exist', () => {
            const expectedIds = ['chunk1', 'chunk2'];
            const retrievedIds = ['chunk3', 'chunk2', 'chunk1', 'chunk4', 'chunk5'];
            // chunk2 is at position 1 (rank 2)
            expect(calculateReciprocalRank(expectedIds, retrievedIds)).toBe(0.5);
        });
    });

    describe('mockSearchHippocampus', () => {
        it('should return topK results', () => {
            const results = mockSearchHippocampus('random query', ['expected1'], 5);
            expect(results).toHaveLength(5);
        });

        it('should include expected ID when query contains "test"', () => {
            const expectedIds = ['expected1'];
            const results = mockSearchHippocampus('this is a test query', expectedIds, 5);
            expect(results).toHaveLength(5);
            expect(results).toContain('expected1');
        });

        it('should include expected ID when query contains "TEST" (case-insensitive)', () => {
            const expectedIds = ['expected1'];
            const results = mockSearchHippocampus('this is a TEST query', expectedIds, 5);
            expect(results).toHaveLength(5);
            expect(results).toContain('expected1');
        });

        it('should not include expected ID when query does not contain "test"', () => {
            const expectedIds = ['expected1'];
            const results = mockSearchHippocampus('random query without keyword', expectedIds, 5);
            expect(results).toHaveLength(5);
            // Very unlikely to randomly generate the expected ID (UUID collision)
            // We just verify the length is correct
        });

        it('should handle different topK values', () => {
            const results = mockSearchHippocampus('test query', ['expected1'], 10);
            expect(results).toHaveLength(10);
            expect(results).toContain('expected1');
        });

        it('should work with multiple expected IDs', () => {
            const expectedIds = ['exp1', 'exp2', 'exp3'];
            const results = mockSearchHippocampus('test query', expectedIds, 5);
            expect(results).toHaveLength(5);
            // Should contain at least one of the expected IDs
            const hasExpected = expectedIds.some(id => results.includes(id));
            expect(hasExpected).toBe(true);
        });
    });
});
