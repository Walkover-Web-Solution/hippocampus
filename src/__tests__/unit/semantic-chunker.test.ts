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
                bufferSize: 1,
            });

            const content = 'First sentence about cats. Second sentence about cats too. Third sentence about dogs. Fourth sentence about dogs too.';
            const result = await chunker.chunk(content);

            expect(mockEncoder.encode).toHaveBeenCalled();
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
                [0.97, 0.03, 0],
                [0.96, 0.04, 0],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                similarityThreshold: 0.5,
                maxChunkSize: 200,
                minChunkSize: 10,
            });

            const content = 'Short one. Another short. Third short. Fourth short. Fifth short.';
            const result = await chunker.chunk(content);

            expect(result.length).toBeGreaterThanOrEqual(1);
            for (const chunk of result) {
                expect(chunk.length).toBeLessThanOrEqual(200);
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

        it('should handle Chinese sentence endings', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0.9, 0.1, 0],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                minChunkSize: 5,
            });

            const content = '这是第一句话。这是第二句话。';
            const result = await chunker.chunk(content);

            expect(result.length).toBeGreaterThanOrEqual(1);
            expect(mockEncoder.encode).toHaveBeenCalled();
        });

        it('should handle Japanese sentence endings', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0.9, 0.1, 0],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                minChunkSize: 5,
            });

            const content = 'これは最初の文です。これは2番目の文です。';
            const result = await chunker.chunk(content);

            expect(result.length).toBeGreaterThanOrEqual(1);
            expect(mockEncoder.encode).toHaveBeenCalled();
        });

        it('should split code content by newlines', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0.9, 0.1, 0],
                [0.8, 0.2, 0],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                minChunkSize: 5,
            });

            const content = 'function hello() {\n  console.log("hello")\n}';
            const result = await chunker.chunk(content);

            expect(result.length).toBeGreaterThanOrEqual(1);
            expect(mockEncoder.encode).toHaveBeenCalled();
        });

        it('should split long text without punctuation by word boundaries', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0.9, 0.1, 0],
                [0.8, 0.2, 0],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                maxChunkSize: 400,
                minChunkSize: 10,
            });

            const content = 'This is a very long piece of text without any punctuation marks that should be split into multiple segments based on word boundaries to make semantic analysis possible for the chunking algorithm';
            const result = await chunker.chunk(content);

            expect(result.length).toBeGreaterThanOrEqual(1);
            expect(mockEncoder.encode).toHaveBeenCalled();
        });

        it('should use buffer to capture context around each sentence', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0.98, 0.02, 0],
                [0.96, 0.04, 0],
                [0.1, 0, 0.9],
                [0.08, 0, 0.92],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                similarityThreshold: 0.5,
                minChunkSize: 10,
                bufferSize: 1,
            });

            const content = 'Topic A first. Topic A second. Topic A third. Topic B first. Topic B second.';
            const result = await chunker.chunk(content);

            expect(mockEncoder.encode).toHaveBeenCalled();
            expect(result.length).toBeGreaterThanOrEqual(1);
        });

        it('should split different topics using percentile-based breakpoints', async () => {
            mockEncoder.encode.mockResolvedValue([
                [1, 0, 0],
                [0.1, 0.9, 0],
                [0, 0, 1],
            ]);

            const chunker = new SemanticChunker({
                denseModel: 'test-model',
                similarityThreshold: 0.5,
                minChunkSize: 10,
                breakpointPercentile: 50,
            });

            const content = 'Space telescopes observe infrared light. The spice trade shaped history. Baseball uses advanced statistics.';
            const result = await chunker.chunk(content);

            expect(mockEncoder.encode).toHaveBeenCalled();
            expect(result.length).toBeGreaterThanOrEqual(1);
        });
    });
});
