import { Encoder } from "./encoder";

interface SemanticChunkerOptions {
    denseModel: string;
    similarityThreshold?: number;
    minChunkSize?: number;
    maxChunkSize?: number;
}

export class SemanticChunker {
    private encoder: Encoder;
    private denseModel: string;
    private similarityThreshold: number;
    private minChunkSize: number;
    private maxChunkSize: number;

    constructor(options: SemanticChunkerOptions) {
        this.encoder = new Encoder();
        this.denseModel = options.denseModel;
        this.similarityThreshold = options.similarityThreshold ?? 0.5;
        this.minChunkSize = options.minChunkSize ?? 50;
        this.maxChunkSize = options.maxChunkSize ?? 2000;
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

        const embeddings = await this.encoder.encode(sentences, this.denseModel);
        const breakpoints = this.findBreakpoints(embeddings);
        return this.groupSentencesIntoChunks(sentences, breakpoints);
    }

    private splitIntoSentences(content: string): string[] {
        const sentenceRegex = /[^.!?]*[.!?]+/g;
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

        if (sentences.length === 0) {
            const trimmed = content.trim();
            return trimmed.length > 0 ? [trimmed] : [];
        }

        return sentences;
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

    private findBreakpoints(embeddings: number[][]): number[] {
        const breakpoints: number[] = [];
        
        for (let i = 0; i < embeddings.length - 1; i++) {
            const similarity = this.cosineSimilarity(embeddings[i], embeddings[i + 1]);
            if (similarity < this.similarityThreshold) {
                breakpoints.push(i);
            }
        }

        return breakpoints;
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
