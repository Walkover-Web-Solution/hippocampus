import axios from '../../config/axios';
import { generateEmbedding, generateLateInteractionEmbedding, generateSparseEmbedding, requiresIdf } from '../../service/encoder/fast-embed';

jest.mock('../../config/axios', () => ({
    __esModule: true,
    default: { post: jest.fn() },
}));

describe('generateEmbedding', () => {
    const mockPost = axios.post as jest.Mock;

    beforeEach(() => {
        mockPost.mockImplementation((_url: string, body: { texts: string[] }) =>
            Promise.resolve({ data: { embeddings: body.texts.map(() => [0.1, 0.2]) } })
        );
    });

    it('should send input_type to the embedding server when provided', async () => {
        await generateEmbedding(['what is rag?'], 'google/embeddinggemma-300m', 'query');

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/embed'),
            { model: 'google/embeddinggemma-300m', texts: ['what is rag?'], input_type: 'query' },
            expect.anything()
        );
    });

    it('should leave input_type undefined when not provided', async () => {
        await generateEmbedding(['hello'], 'BAAI/bge-small-en-v1.5');

        const body = mockPost.mock.calls[0][1];
        expect(body.input_type).toBeUndefined();
        // undefined fields are dropped from the JSON body, so older servers see the same request as before
        expect(JSON.parse(JSON.stringify(body))).toEqual({ model: 'BAAI/bge-small-en-v1.5', texts: ['hello'] });
    });

    it('should return embeddings in the original order', async () => {
        const result = await generateEmbedding(['a', 'a much longer text'], 'BAAI/bge-small-en-v1.5', 'document');

        expect(result).toHaveLength(2);
        expect(mockPost.mock.calls.every((call) => call[1].input_type === 'document')).toBe(true);
    });
});

describe('generateSparseEmbedding / generateLateInteractionEmbedding', () => {
    const mockPost = axios.post as jest.Mock;

    it('should send input_type to /sparse-embed', async () => {
        mockPost.mockResolvedValue({ data: { embeddings: [{ '12': 1.0 }] } });

        const result = await generateSparseEmbedding(['refund policy'], 'Qdrant/bm25', 'query');

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/sparse-embed'),
            { model: 'Qdrant/bm25', texts: ['refund policy'], input_type: 'query' },
            expect.anything()
        );
        expect(result).toEqual([{ indices: [12], values: [1.0] }]);
    });

    it('should send input_type to /late-interaction-embed', async () => {
        mockPost.mockResolvedValue({ data: { embeddings: [[[0.1, 0.2]]] } });

        await generateLateInteractionEmbedding(['refund policy'], 'colbert-ir/colbertv2.0', 'query');

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/late-interaction-embed'),
            { model: 'colbert-ir/colbertv2.0', texts: ['refund policy'], input_type: 'query' },
            expect.anything()
        );
    });
});

describe('requiresIdf', () => {
    it('should be true only for sparse models that rely on Qdrant IDF', () => {
        expect(requiresIdf('Qdrant/bm25')).toBe(true);
        expect(requiresIdf('Qdrant/minicoil-v1')).toBe(true);
        expect(requiresIdf('prithivida/Splade_PP_en_v1')).toBe(false);
        expect(requiresIdf(undefined)).toBe(false);
    });
});
