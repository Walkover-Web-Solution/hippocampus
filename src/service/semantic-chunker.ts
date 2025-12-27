import { Encoder } from "./encoder";
import logger from "./logger";

interface SemanticChunkerOptions {
    denseModel: string;
    minChunkSize?: number;
    maxChunkSize?: number;
}

export class SemanticChunker {
    private encoder: Encoder;
    private denseModel: string;
    private minChunkSize: number;
    private maxChunkSize: number;

    constructor(options: SemanticChunkerOptions) {
        this.encoder = new Encoder();
        this.denseModel = options.denseModel;
        this.minChunkSize = options.minChunkSize || 50;
        this.maxChunkSize = options.maxChunkSize || 2000;
    }

    async chunk(content: string): Promise<string[]> {
        if (!content || content.trim().length === 0) {
            return [];
        }

        const sentences = await this.splitIntoSentences(content);
        if (sentences.length === 0) {
            return [];
        }

        if (sentences.length === 1) {
            return sentences;
        }

        const embeddings = await this.encoder.encode(sentences, this.denseModel);
        const similarities = this.calculateSimilarities(embeddings);
        const breakpoints = this.findBreakpoints(similarities, 20);
        return this.groupSentencesIntoChunks(sentences, breakpoints);
    }

    private calculateSimilarities(embeddings: number[][]): number[] {
        const similarities: number[] = [];
        for (let i = 0; i < embeddings.length - 1; i++) {
            similarities.push(this.cosineSimilarity(embeddings[i], embeddings[i + 1]));
        }
        return similarities;
    }

    private findBreakpoints(similarities: number[], percentile: number = 20, boundary: { upper: number, lower: number } = { upper: 90, lower: 40 }): number[] {
        if (similarities.length === 0) {
            return [];
        }

        // We sort a copy of the array to find the value at the bottom X%.
        const sortedSims = [...similarities].sort((a, b) => a - b);
        // Cut off index where the bottom X% lies - e.g., 20th percentile
        const index = Math.floor(sortedSims.length * (percentile / 100));

        // Ensure index is within bounds
        const safeIndex = Math.min(Math.max(0, index), sortedSims.length - 1);

        let determinedThreshold = sortedSims[safeIndex];
        const upperBoundary = boundary.upper; // Don't split if similarity is above this percentile
        const lowerBoundary = boundary.lower; // Always split if similarity is below this percentile
        if (determinedThreshold * 100 > upperBoundary) {
            determinedThreshold = Math.min(determinedThreshold, upperBoundary / 100);
        } else if (determinedThreshold * 100 < lowerBoundary) {
            determinedThreshold = Math.max(determinedThreshold, lowerBoundary / 100);
        }

        logger.debug(`Determined Breakpoint Threshold: ${determinedThreshold} (Percentile: ${percentile}%, Boundary: ${upperBoundary}%-${lowerBoundary}%)`);
        // 3. Find the Indices (The Breakpoints)
        const breakpoints: number[] = [];
        for (let i = 0; i < similarities.length; i++) {
            // If similarity is lower than or equal to our calculated cutoff, it's a split.
            if (similarities[i] <= determinedThreshold) {
                breakpoints.push(i + 1);
            }
        }

        return breakpoints;
    }

    private async splitIntoSentences(content: string): Promise<string[]> {
        if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
            const segmenter = new (Intl as any).Segmenter('en', { granularity: 'sentence' });
            const segments = segmenter.segment(content);
            const sentences: string[] = [];

            for (const segment of segments) {
                const clean = segment.segment.trim();
                if (clean.length > 0) sentences.push(clean);
            }

            // Fallback to length split if a sentence is massive
            return sentences.flatMap(s =>
                s.length > this.maxChunkSize ? this.splitByLength(s) : [s]
            );
        }

        // Fallback to your regex implementation if Segmenter fails
        return this.splitBySentenceEndings(content);
    }

    private splitBySentenceEndings(content: string): string[] {
        const sentenceRegex = /[^.!?。！？؟]+[.!?。！？؟]+[\s]*/g;
        const sentences: string[] = [];
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = sentenceRegex.exec(content)) !== null) {
            const trimmed = match[0].trim();
            if (trimmed.length > 0) {
                sentences.push(trimmed);
            }
            lastIndex = match.index + match[0].length;
        }

        const remaining = content.substring(lastIndex).trim();
        if (remaining.length > 0) {
            sentences.push(remaining);
        }

        return sentences.filter(s => s.length > 0);
    }

    private splitByLength(content: string): string[] {
        const trimmed = content.trim();
        if (trimmed.length === 0) {
            return [];
        }

        const targetLength = Math.min(200, this.maxChunkSize / 4);
        if (trimmed.length <= targetLength) {
            return [trimmed];
        }

        const segments: string[] = [];
        const words = trimmed.split(/\s+/);
        let current = "";

        for (const word of words) {
            const testLength = current.length + (current.length > 0 ? 1 : 0) + word.length;
            if (testLength > targetLength && current.length > 0) {
                segments.push(current);
                current = word;
            } else {
                current = current.length > 0 ? current + " " + word : word;
            }
        }

        if (current.length > 0) {
            segments.push(current);
        }

        return segments;
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        if (vecA.length !== vecB.length || vecA.length === 0) {
            return 0;
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }

        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        if (denominator === 0) {
            return 0;
        }

        return dotProduct / denominator;
    }

    private groupSentencesIntoChunks(sentences: string[], breakpoints: number[]): string[] {
        const chunks: string[] = [];
        let currentChunk: string[] = [];
        let currentLength = 0;
        const breakpointSet = new Set(breakpoints);

        for (let i = 0; i < sentences.length; i++) {
            const sentence = sentences[i];
            const sentenceLength = sentence.length;

            // 1. Forced Split: Size Limit
            if (currentChunk.length > 0 && (currentLength + 1 + sentenceLength) > this.maxChunkSize) {
                chunks.push(currentChunk.join(" "));
                currentChunk = [];
                currentLength = 0;
            }

            // 2. Semantic Split: Breakpoint detected
            if (breakpointSet.has(i) && currentChunk.length > 0) {
                // Only break if the current chunk has enough meat (minChunkSize)
                // If it's too small, we ignore the semantic break to avoid fragmentation.
                if (currentLength >= this.minChunkSize) {
                    chunks.push(currentChunk.join(" "));
                    currentChunk = [];
                    currentLength = 0;
                }
            }

            // 3. Add sentence to the (potentially new) chunk
            currentChunk.push(sentence);
            currentLength += (currentChunk.length > 1 ? 1 : 0) + sentenceLength;
        }

        // 4. Handle the final leftover chunk
        if (currentChunk.length > 0) {
            const lastChunkContent = currentChunk.join(" ");

            // Merge logic: If the last chunk is too small, glue it to the previous one
            if (chunks.length > 0 && lastChunkContent.length < this.minChunkSize) {
                // Check if merging violates maxChunkSize
                const combined = chunks[chunks.length - 1] + " " + lastChunkContent;
                if (combined.length <= this.maxChunkSize) {
                    chunks[chunks.length - 1] = combined;
                } else {
                    chunks.push(lastChunkContent); // Keep it separate if merging makes it too big
                }
            } else {
                chunks.push(lastChunkContent);
            }
        }

        return chunks;
    }
}
