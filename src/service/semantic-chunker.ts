import { Encoder } from "./encoder";

interface SemanticChunkerOptions {
    denseModel: string;
    similarityThreshold?: number;
    minChunkSize?: number;
    maxChunkSize?: number;
    windowSize?: number;
}

export class SemanticChunker {
    private encoder: Encoder;
    private denseModel: string;
    private similarityThreshold: number;
    private minChunkSize: number;
    private maxChunkSize: number;
    private windowSize: number;

    constructor(options: SemanticChunkerOptions) {
        this.encoder = new Encoder();
        this.denseModel = options.denseModel;
        this.similarityThreshold = options.similarityThreshold ?? 0.5;
        this.minChunkSize = options.minChunkSize ?? 50;
        this.maxChunkSize = options.maxChunkSize ?? 2000;
        const windowSize = options.windowSize ?? 3;
        this.windowSize = Math.max(1, Math.floor(windowSize));
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

        const windowTexts = this.createSlidingWindows(sentences);
        const windowEmbeddings = await this.encoder.encode(windowTexts, this.denseModel);
        const breakpoints = this.findBreakpointsWithWindows(windowEmbeddings, sentences.length);
        return this.groupSentencesIntoChunks(sentences, breakpoints);
    }

    private createSlidingWindows(sentences: string[]): string[] {
        const windows: string[] = [];
        const halfWindow = Math.floor(this.windowSize / 2);

        for (let i = 0; i < sentences.length; i++) {
            const start = Math.max(0, i - halfWindow);
            const end = Math.min(sentences.length, i + halfWindow + 1);
            const windowText = sentences.slice(start, end).join(" ");
            windows.push(windowText);
        }

        return windows;
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

    private findBreakpointsWithWindows(windowEmbeddings: number[][], sentenceCount: number): number[] {
        if (sentenceCount <= 1) {
            return [];
        }

        const similarities: number[] = [];
        for (let i = 0; i < windowEmbeddings.length - 1; i++) {
            const similarity = this.cosineSimilarity(windowEmbeddings[i], windowEmbeddings[i + 1]);
            similarities.push(similarity);
        }

        if (similarities.length === 0) {
            return [];
        }

        const breakpoints: number[] = [];
        const mean = similarities.reduce((a, b) => a + b, 0) / similarities.length;
        const stdDev = Math.sqrt(
            similarities.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / similarities.length
        );

        const dynamicThreshold = Math.max(
            this.similarityThreshold,
            mean - stdDev
        );

        for (let i = 0; i < similarities.length; i++) {
            const isLocalMinimum = (
                (i === 0 || similarities[i] <= similarities[i - 1]) &&
                (i === similarities.length - 1 || similarities[i] <= similarities[i + 1])
            );

            if (similarities[i] < dynamicThreshold && isLocalMinimum) {
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
