process.env.MEMORY_FAKE_MODELS = 'true';
process.env.MEMORY_EXTRACTION_MODEL = 'claude-haiku-5-5';
process.env.MEMORY_EXTRACTION_FALLBACK_MODEL = 'gpt-4.1-mini';

// Required after the environment is set, because the config reads it when the module loads.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ChatModels, providerFor } = require('../llm');

describe('extraction model routing', () => {
    it('sends Claude models to Anthropic and everything else to OpenAI', () => {
        expect(providerFor('claude-haiku-5-5')).toBe('anthropic');
        expect(providerFor('claude-sonnet-5-5')).toBe('anthropic');
        expect(providerFor('gpt-4.1-mini')).toBe('openai');
        expect(providerFor('gpt-5.4-nano')).toBe('openai');
    });

    it('asks the fallback model, on its own provider, when the first model throws', async () => {
        const anthropic = { ask: jest.fn().mockRejectedValue(new Error('overloaded')) };
        const openai = { ask: jest.fn().mockResolvedValue({ decision: 'duplicate', ref: 1 }) };
        const models = new ChatModels({ anthropic, openai });
        const known = [{ ref: 1, kind: 'fact', slot: null, text: 'Works at Acme.' }];
        await expect(models.reconcile('Works at Acme Inc.', known)).resolves.toEqual({ decision: 'duplicate', ref: 1 });
        expect(anthropic.ask).toHaveBeenCalledWith('claude-haiku-5-5', expect.any(String), expect.any(String), 'memory_reconcile', expect.any(Object));
        expect(openai.ask).toHaveBeenCalledWith('gpt-4.1-mini', expect.any(String), expect.any(String), 'memory_reconcile', expect.any(Object));
    });

    it('does not touch the fallback when the first model answers', async () => {
        const anthropic = { ask: jest.fn().mockResolvedValue({ decision: 'NEW', ref: null }) };
        const openai = { ask: jest.fn() };
        const models = new ChatModels({ anthropic, openai });
        // Enum casing from the model is not relied on.
        await expect(models.reconcile('Likes tea.', [])).resolves.toEqual({ decision: 'new', ref: null });
        expect(openai.ask).not.toHaveBeenCalled();
    });
});

describe('product instructions in extraction', () => {
    const context = (over: object = {}) => ({ sharedSpace: null, today: '2026-10-21', rulesAllowed: true, knownEntities: [], ...over });

    it('hands the product instructions to the model as fenced data, framed as relevance only', async () => {
        const anthropic = { ask: jest.fn().mockResolvedValue({ operations: [] }) };
        const models = new ChatModels({ anthropic, openai: { ask: jest.fn() } });
        await models.extract('I like hiking.', [], context({ instructions: 'Only save billing and order information.' }));
        const system = anthropic.ask.mock.calls[0][1] as string;
        expect(system).toContain('"""\nOnly save billing and order information.\n"""');
        expect(system).toContain('They decide relevance only');
    });

    it('adds nothing when the product gives no instructions', async () => {
        const anthropic = { ask: jest.fn().mockResolvedValue({ operations: [] }) };
        const models = new ChatModels({ anthropic, openai: { ask: jest.fn() } });
        await models.extract('I like hiking.', [], context());
        await models.extract('I like hiking.', [], context({ instructions: '   ' }));
        for (const call of anthropic.ask.mock.calls) {
            expect(call[1]).not.toContain('The product running this memory');
        }
    });
});
