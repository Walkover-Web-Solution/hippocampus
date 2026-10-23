import axios from '../../config/axios';
import { generateEmbedding } from '../../service/encoder/fast-embed';

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
