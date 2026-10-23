import qdrantClient from '../../config/qdrant';
import { insert } from '../../service/qdrant';

jest.mock('../../config/qdrant', () => ({
    __esModule: true,
    default: {
        collectionExists: jest.fn(),
        createCollection: jest.fn(),
        createPayloadIndex: jest.fn(),
        upsert: jest.fn(),
    },
}));

describe('insert', () => {
    const client = qdrantClient as unknown as Record<string, jest.Mock>;
    const point = { id: 'a', vector: { dense: [0.1, 0.2], sparse: { indices: [1], values: [1] } } };

    beforeEach(() => {
        client.collectionExists.mockResolvedValue({ exists: false });
        client.createCollection.mockResolvedValue(true);
        client.createPayloadIndex.mockResolvedValue(true);
        client.upsert.mockResolvedValue({ status: 'completed' });
    });

    it('should create the sparse vector with the IDF modifier when requested', async () => {
        await insert('col', [point], { sparseIdf: true });

        const config = client.createCollection.mock.calls[0][1];
        expect(config.sparse_vectors).toEqual({ sparse: { modifier: 'idf' } });
        expect(config.vectors.dense.size).toBe(2);
    });

    it('should create the sparse vector without a modifier by default', async () => {
        await insert('col', [point]);

        expect(client.createCollection.mock.calls[0][1].sparse_vectors).toEqual({ sparse: {} });
    });

    it('should not touch the config of an existing collection', async () => {
        client.collectionExists.mockResolvedValue({ exists: true });

        await insert('col', [point], { sparseIdf: true });

        expect(client.createCollection).not.toHaveBeenCalled();
        expect(client.upsert).toHaveBeenCalled();
    });
});
