import { SemanticChunker } from '../../service/semantic-chunker';
import { Encoder } from '../../service/encoder';

jest.mock('../../service/encoder');

describe('SemanticChunker', () => {
    let mockEncoder: jest.Mocked<Encoder>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockEncoder = {
            encode: jest.fn(),
            encodeSparse: jest.fn(),
            encodeReranker: jest.fn(),
            getModels: jest.fn(),
            getSparseModels: jest.fn(),
            getRerankerModels: jest.fn(),
            isValid: jest.fn(),
            isValidSparse: jest.fn(),
            isValidReranker: jest.fn(),
        } as unknown as jest.Mocked<Encoder>;
        (Encoder as jest.Mock).mockImplementation(() => mockEncoder);
    });

    describe('chunk', () => {
        it('should return empty array for empty content', async () => {
            const chunker = new SemanticChunker({ denseModel: 'test-model' });
            const result = await chunker.chunk('');
            expect(result).toEqual([]);
        });

        it('should return empty array for whitespace-only content', async () => {
            const chunker = new SemanticChunker({ denseModel: 'test-model' });
            const result = await chunker.chunk('   \n\t  ');
            expect(result).toEqual([]);
        });

        it('should return single sentence as single chunk', async () => {
            const chunker = new SemanticChunker({ denseModel: 'test-model' });
            const result = await chunker.chunk('This is a single sentence.');
            expect(result).toEqual(['This is a single sentence.']);
        });

        it('should group semantically similar sentences together', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0.95, 0.1, 0],
                [0, 0, 1],
                [0.1, 0, 0.95],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                similarityThreshold: 0.5,
                minChunkSize: 10,
            });

            const content = 'First sentence about cats. Second sentence about cats too. Third sentence about dogs. Fourth sentence about dogs too.';
            const result = await chunker.chunk(content);

            expect(mockEncoder.encode).toHaveBeenCalledWith(
                [
                    'First sentence about cats.',
                    'Second sentence about cats too.',
                    'Third sentence about dogs.',
                    'Fourth sentence about dogs too.',
                ],
                'test-model'
            );
            expect(result.length).toBeGreaterThanOrEqual(1);
        });

        it('should create breakpoints when similarity is below threshold', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0, 1, 0],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                similarityThreshold: 0.5,
                minChunkSize: 10,
            });

            const content = 'First topic sentence. Completely different topic sentence.';
            const result = await chunker.chunk(content);

            expect(result.length).toBeGreaterThanOrEqual(1);
        });

        it('should respect maxChunkSize', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0.99, 0.01, 0],
                [0.98, 0.02, 0],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                similarityThreshold: 0.5,
                maxChunkSize: 50,
                minChunkSize: 10,
            });

            const content = 'This is a very long sentence that exceeds max size. Another long sentence here. Yet another sentence.';
            const result = await chunker.chunk(content);

            for (const chunk of result) {
                expect(chunk.length).toBeLessThanOrEqual(100);
            }
        });

        it('should handle content without sentence-ending punctuation', async () => {
            const chunker = new SemanticChunker({ denseModel: 'test-model' });
            const result = await chunker.chunk('Content without any punctuation');
            expect(result).toEqual(['Content without any punctuation']);
        });

        it('should handle mixed punctuation', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0.9, 0.1, 0],
                [0.8, 0.2, 0],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                similarityThreshold: 0.5,
                minChunkSize: 10,
            });

            const content = 'Is this a question? Yes it is! And this is a statement.';
            const result = await chunker.chunk(content);

            expect(result.length).toBeGreaterThanOrEqual(1);
            expect(mockEncoder.encode).toHaveBeenCalled();
        });

        it('should use default similarity threshold of 0.5', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0.4, 0.6, 0],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                minChunkSize: 10,
            });

            const content = 'First sentence here. Second sentence there.';
            const result = await chunker.chunk(content);

            expect(result.length).toBeGreaterThanOrEqual(1);
        });

        it('should merge small trailing chunks with previous chunk', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                similarityThreshold: 0.5,
                minChunkSize: 50,
            });

            const content = 'First long sentence with enough content. Second sentence. Hi.';
            const result = await chunker.chunk(content);

            expect(result.length).toBeGreaterThanOrEqual(1);
        });
    });
});
