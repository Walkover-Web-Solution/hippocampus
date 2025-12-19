import { Encoder } from "./encoder";

interface SemanticChunkerOptions {
    denseModel: string;
    similarityThreshold?: number;
    minChunkSize?: number;
    maxChunkSize?: number;
    bufferSize?: number;
    breakpointPercentile?: number;
}

export class SemanticChunker {
    private encoder: Encoder;
    private denseModel: string;
    private similarityThreshold: number;
    private minChunkSize: number;
    private maxChunkSize: number;
    private bufferSize: number;
    private breakpointPercentile: number;

    constructor(options: SemanticChunkerOptions) {
        this.encoder = new Encoder();
        this.denseModel = options.denseModel;
        this.similarityThreshold = options.similarityThreshold ?? 0.5;
        this.minChunkSize = options.minChunkSize ?? 50;
        this.maxChunkSize = options.maxChunkSize ?? 2000;
        this.bufferSize = Math.max(1, Math.floor(options.bufferSize ?? 1));
        this.breakpointPercentile = Math.min(100, Math.max(0, options.breakpointPercentile ?? 95));
    }

    async chunk(content: string): Promise<string[]> {
        if (!content || content.trim().length === 0) {
            return [];
        }

        const sentences = this.splitIntoSentences(content);
        if (sentences.length === 0) {
            return [];
        }

        if (sentences.length === 1) {
            return sentences;
        }

        const combinedSentences = this.combineSentencesWithBuffer(sentences);
        const embeddings = await this.encoder.encode(combinedSentences, this.denseModel);
        const similarities = this.calculateSimilarities(embeddings);
        const breakpoints = this.findBreakpoints(similarities);
        return this.groupSentencesIntoChunks(sentences, breakpoints);
    }

    private combineSentencesWithBuffer(sentences: string[]): string[] {
        if (this.bufferSize <= 0) {
            return sentences;
        }

        const combined: string[] = [];
        for (let i = 0; i < sentences.length; i++) {
            const start = Math.max(0, i - this.bufferSize);
            const end = Math.min(sentences.length, i + this.bufferSize + 1);
            combined.push(sentences.slice(start, end).join(" "));
        }
        return combined;
    }

    private calculateSimilarities(embeddings: number[][]): number[] {
        const similarities: number[] = [];
        for (let i = 0; i < embeddings.length - 1; i++) {
            similarities.push(this.cosineSimilarity(embeddings[i], embeddings[i + 1]));
        }
        return similarities;
    }

    private findBreakpoints(similarities: number[]): number[] {
        if (similarities.length === 0) {
            return [];
        }

        const distances = similarities.map(s => 1 - s);
        const sortedDistances = [...distances].sort((a, b) => a - b);
        const percentileIndex = Math.min(
            Math.floor((this.breakpointPercentile / 100) * (sortedDistances.length - 1)),
            sortedDistances.length - 1
        );
        const percentileThreshold = sortedDistances[percentileIndex];

        const breakpoints: number[] = [];
        for (let i = 0; i < distances.length; i++) {
            const isAbovePercentile = distances[i] >= percentileThreshold;
            const isBelowSimilarityThreshold = similarities[i] < this.similarityThreshold;

            const isLocalMaxDistance = (
                (i === 0 || distances[i] >= distances[i - 1]) &&
                (i === distances.length - 1 || distances[i] >= distances[i + 1])
            );

            if ((isAbovePercentile || isBelowSimilarityThreshold) && isLocalMaxDistance) {
                breakpoints.push(i);
            }
        }

        return breakpoints;
    }

    private splitIntoSentences(content: string): string[] {
        const sentences = this.splitBySentenceEndings(content);
        if (sentences.length > 1) {
            return sentences;
        }

        const linesSplit = this.splitByNewlines(content);
        if (linesSplit.length > 1) {
            return linesSplit;
        }

        return this.splitByLength(content);
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

    private splitByNewlines(content: string): string[] {
        const lines = content.split(/\n+/);
        return lines
            .map(line => line.trim())
            .filter(line => line.length > 0);
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
            const spaceNeeded = currentChunk.length > 0 ? 1 : 0;
            const newLength = currentLength + spaceNeeded + sentenceLength;

            if (newLength > this.maxChunkSize && currentChunk.length > 0) {
                chunks.push(currentChunk.join(" "));
                currentChunk = [sentence];
                currentLength = sentenceLength;
            } else if (breakpointSet.has(i) && currentLength >= this.minChunkSize) {
                currentChunk.push(sentence);
                chunks.push(currentChunk.join(" "));
                currentChunk = [];
                currentLength = 0;
            } else {
                currentChunk.push(sentence);
                currentLength = newLength;
            }
        }

        if (currentChunk.length > 0) {
            const lastChunk = currentChunk.join(" ");
            if (chunks.length > 0 && lastChunk.length < this.minChunkSize) {
                chunks[chunks.length - 1] = chunks[chunks.length - 1] + " " + lastChunk;
            } else {
                chunks.push(lastChunk);
            }
        }

        return chunks;
    }
}
