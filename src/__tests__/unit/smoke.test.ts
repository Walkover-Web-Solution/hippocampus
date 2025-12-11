describe('Smoke Test', () => {
    it('should be able to run a simple test', () => {
        expect(1 + 1).toBe(2);
    });

    it('should handle async operations', async () => {
        const result = await Promise.resolve('success');
        expect(result).toBe('success');
    });
});
