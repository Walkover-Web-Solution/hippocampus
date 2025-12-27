import { v4 as uuidv4 } from 'uuid';

/**
 * Mock function to simulate vector database search.
 * Returns random IDs, but returns the correct ID if the query contains the word "test".
 * This allows verifying the evaluation logic works correctly.
 */
export function mockSearchHippocampus(query: string, expectedIds: string[], topK: number = 5): string[] {
    const results: string[] = [];
    
    // If query contains "test", include one of the expected IDs at a random position
    if (query.toLowerCase().includes('test') && expectedIds.length > 0) {
        // Pick a random expected ID
        const correctId = expectedIds[Math.floor(Math.random() * expectedIds.length)];
        // Place it at a random position within the results
        const correctPosition = Math.floor(Math.random() * topK);
        
        for (let i = 0; i < topK; i++) {
            if (i === correctPosition) {
                results.push(correctId);
            } else {
                // Generate random UUID as a mock chunk ID
                results.push(uuidv4());
            }
        }
    } else {
        // Generate all random IDs
        for (let i = 0; i < topK; i++) {
            results.push(uuidv4());
        }
    }
    
    return results;
}

/**
 * Calculate if any expected chunk IDs appear in the retrieved results (Hit)
 */
export function calculateHit(expectedIds: string[], retrievedIds: string[]): boolean {
    return expectedIds.some(id => retrievedIds.includes(id));
}

/**
 * Calculate Recall@K: (Count of Expected IDs found in Retrieved) / (Total Expected IDs)
 */
export function calculateRecall(expectedIds: string[], retrievedIds: string[]): number {
    if (expectedIds.length === 0) return 0;
    const foundCount = expectedIds.filter(id => retrievedIds.includes(id)).length;
    return foundCount / expectedIds.length;
}

/**
 * Calculate Reciprocal Rank (RR): 1 / rank of first matching relevant ID
 * Returns 0 if no match found
 */
export function calculateReciprocalRank(expectedIds: string[], retrievedIds: string[]): number {
    for (let i = 0; i < retrievedIds.length; i++) {
        if (expectedIds.includes(retrievedIds[i])) {
            // Rank is 1-indexed, so position 0 means rank 1
            return 1 / (i + 1);
        }
    }
    return 0;
}
