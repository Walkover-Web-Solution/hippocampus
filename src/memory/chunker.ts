/**
 * Splits a note body into chunks for embedding: on paragraph boundaries first, then sentences, about `size`
 * characters each with `overlap` characters carried over from the previous chunk so a thought cut in two is still
 * found. A short note is exactly one chunk.
 */
export interface TextChunk {
    ordinal: number;
    text: string;
}

export interface ChunkOptions {
    size?: number;
    overlap?: number;
}

const DEFAULT_SIZE = 800;
const DEFAULT_OVERLAP = 100;

const sentences = (paragraph: string): string[] => paragraph.split(/(?<=[.!?])\s+(?=[^a-z])/u).map((part) => part.trim()).filter(Boolean);

// Pieces no longer than `size`: paragraphs, then sentences, then hard cuts for anything still too long.
const units = (body: string, size: number): string[] => {
    const out: string[] = [];
    for (const paragraph of body.split(/\n\s*\n/)) {
        const text = paragraph.trim();
        if (!text) continue;
        if (text.length <= size) {
            out.push(text);
            continue;
        }
        for (const sentence of sentences(text)) {
            if (sentence.length <= size) {
                out.push(sentence);
                continue;
            }
            for (let start = 0; start < sentence.length; start += size) out.push(sentence.slice(start, start + size));
        }
    }
    return out;
};

// The last `overlap` characters of a chunk, from a word boundary.
const tail = (text: string, overlap: number): string => {
    if (overlap <= 0) return '';
    if (text.length <= overlap) return text;
    const slice = text.slice(-overlap);
    const boundary = slice.search(/\s/);
    return boundary >= 0 ? slice.slice(boundary + 1) : slice;
};

export function chunkText(body: string, { size = DEFAULT_SIZE, overlap = DEFAULT_OVERLAP }: ChunkOptions = {}): TextChunk[] {
    const text = body.replace(/\r\n?/g, '\n').trim();
    if (!text) return [];
    if (text.length <= size) return [{ ordinal: 0, text }];

    const chunks: string[] = [];
    let current = '';
    for (const unit of units(text, size)) {
        const joined = current ? `${current}\n${unit}` : unit;
        if (joined.length <= size || !current) {
            current = joined;
            continue;
        }
        chunks.push(current);
        const carried = tail(current, overlap);
        current = carried && carried.length + unit.length + 1 <= size ? `${carried}\n${unit}` : unit;
    }
    if (current) chunks.push(current);
    return chunks.map((chunk, ordinal) => ({ ordinal, text: chunk }));
}

// The one line an index shows for a note: its first sentence, clipped.
export const firstSentence = (body: string, max = 200): string => {
    const line = body.replace(/\s+/g, ' ').trim();
    const match = line.match(/^.*?[.!?](?=\s|$)/u);
    const sentence = (match ? match[0] : line).trim();
    return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
};
